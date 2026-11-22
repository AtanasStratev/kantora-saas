'use server';
import { parseAmount, postingProblems, type EntryLine } from '@kantora/domain';
import { withTenant } from '@kantora/db';
import { DatabaseError } from 'pg';
import { z } from 'zod';
import { companyScope } from '@/lib/company-scope';
import { appPool } from '@/lib/db';

type Result<T = object> = ({ error?: undefined } & T) | { error: string; problems?: string[] };

/** Database messages raised by our triggers/functions are written for users. */
function dbError(err: unknown): { error: string } {
  if (err instanceof DatabaseError) {
    if (['23514', '22023', '42501'].includes(err.code ?? '')) return { error: err.message };
    if (err.code === '23505') return { error: 'Такъв запис вече съществува.' };
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------
const NewAccount = z.object({
  code: z
    .string()
    .trim()
    .regex(
      /^[0-9A-Za-z][0-9A-Za-z./-]*$/,
      'Кодът може да съдържа цифри, букви, точка, тире и наклонена черта.',
    ),
  name: z.string().trim().min(2, 'Въведете наименование на сметката.').max(200),
  isPostable: z.boolean(),
});

export async function createAccount(input: {
  code: string;
  name: string;
  isPostable: boolean;
}): Promise<Result> {
  const scope = await companyScope('company.edit');
  if ('error' in scope) return { error: scope.error };
  const p = NewAccount.safeParse(input);
  if (!p.success) return { error: p.error.issues[0]?.message ?? 'Невалидни данни.' };
  try {
    await withTenant(appPool, scope.tenant, (c) =>
      c.query(
        'INSERT INTO app.account (office_id, company_id, code, name, is_postable) VALUES ($1, $2, $3, $4, $5)',
        [
          scope.tenant.officeId,
          scope.tenant.companyId,
          p.data.code,
          p.data.name,
          p.data.isPostable,
        ],
      ),
    );
    return {};
  } catch (err) {
    const e = dbError(err);
    return e.error === 'Такъв запис вече съществува.'
      ? { error: `Сметка с код ${p.data.code} вече има в сметкоплана.` }
      : e;
  }
}

// ---------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------
const EntryInput = z.object({
  date: z.iso.date('Въведете дата.'),
  description: z.string().trim().max(500),
  lines: z
    .array(
      z.object({
        accountId: z.uuid('Изберете сметка.'),
        accountCode: z.string(),
        debit: z.string(),
        credit: z.string(),
        description: z.string().max(500),
      }),
    )
    .max(500),
});
export type EntryInput = z.infer<typeof EntryInput>;

/**
 * Saves and posts an entry in ONE transaction: draft → lines → posted. The domain check
 * gives precise messages first; the database re-checks Dt = Кт at commit regardless.
 */
export async function postEntry(
  input: EntryInput,
): Promise<Result<{ id: string; number: number }>> {
  const scope = await companyScope('accounting.post');
  if ('error' in scope) return { error: scope.error };
  const parsed = EntryInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Невалидни данни.' };
  const data = parsed.data;

  const lines: (EntryLine & { accountId: string; description: string })[] = [];
  const problems: string[] = [];
  data.lines.forEach((l, i) => {
    const d = l.debit.trim();
    const c = l.credit.trim();
    if (d && c) problems.push(`Ред ${i + 1}: попълнете или дебит, или кредит, не и двете.`);
    const raw = d || c;
    if (!raw) {
      problems.push(`Ред ${i + 1}: въведете сума.`);
      return;
    }
    const amt = parseAmount(raw);
    if (!amt.ok) {
      problems.push(`Ред ${i + 1}: ${amt.error}`);
      return;
    }
    lines.push({
      accountId: l.accountId,
      accountCode: l.accountCode,
      side: d ? 'D' : 'C',
      amount: amt.value,
      description: l.description,
    });
  });
  problems.push(...postingProblems(lines).map((p) => p.message));
  if (problems.length) return { error: 'Статията не е осчетоводена.', problems };

  try {
    return await withTenant(appPool, scope.tenant, async (c) => {
      const period = await c.query<{ id: string }>(
        'SELECT id FROM app.period WHERE $1::date BETWEEN start_date AND end_date',
        [data.date],
      );
      const periodId = period.rows[0]?.id;
      if (!periodId) {
        return { error: 'За тази дата фирмата няма отчетен период. Проверете годината.' };
      }
      const e = await c.query<{ id: string }>(
        `INSERT INTO app.journal_entry (office_id, company_id, period_id, entry_date, description, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          scope.tenant.officeId,
          scope.tenant.companyId,
          periodId,
          data.date,
          data.description,
          scope.tenant.userId,
        ],
      );
      const id = e.rows[0]?.id;
      if (!id) throw new Error('journal_entry insert returned no id');
      let n = 0;
      for (const l of lines) {
        await c.query(
          `INSERT INTO app.journal_line (office_id, company_id, entry_id, line_no, account_id, side, amount, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            scope.tenant.officeId,
            scope.tenant.companyId,
            id,
            ++n,
            l.accountId,
            l.side,
            l.amount,
            l.description,
          ],
        );
      }
      const posted = await c.query<{ number: number }>(
        `UPDATE app.journal_entry SET status = 'posted' WHERE id = $1 RETURNING number`,
        [id],
      );
      const number = posted.rows[0]?.number;
      if (number === undefined) throw new Error('posting returned no number');
      return { id, number };
    });
  } catch (err) {
    return dbError(err);
  }
}

export async function reverseEntry(entryId: string, date: string): Promise<Result<{ id: string }>> {
  const scope = await companyScope('accounting.post');
  if ('error' in scope) return { error: scope.error };
  const id = z.uuid().safeParse(entryId);
  const d = z.iso.date().safeParse(date);
  if (!id.success || !d.success) return { error: 'Невалидни данни.' };
  try {
    return await withTenant(appPool, scope.tenant, async (c) => {
      const r = await c.query<{ id: string }>('SELECT app.reverse_entry($1, $2) AS id', [
        id.data,
        d.data,
      ]);
      const newId = r.rows[0]?.id;
      if (!newId) throw new Error('reverse_entry returned no id');
      return { id: newId };
    });
  } catch (err) {
    return dbError(err);
  }
}

// ---------------------------------------------------------------------------
// Period lock
// ---------------------------------------------------------------------------
export async function setPeriodLock(periodId: string, locked: boolean): Promise<Result> {
  const scope = await companyScope('period.lock');
  if ('error' in scope) return { error: scope.error };
  const id = z.uuid().safeParse(periodId);
  if (!id.success) return { error: 'Невалиден период.' };
  try {
    await withTenant(appPool, scope.tenant, (c) =>
      locked
        ? c.query(
            'UPDATE app.period SET locked_at = now(), locked_by = $2 WHERE id = $1 AND locked_at IS NULL',
            [id.data, scope.tenant.userId],
          )
        : c.query('UPDATE app.period SET locked_at = NULL, locked_by = NULL WHERE id = $1', [
            id.data,
          ]),
    );
    return {};
  } catch (err) {
    return dbError(err);
  }
}
