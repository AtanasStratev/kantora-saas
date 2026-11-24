'use server';
import {
  analyticsProblems,
  parseAmount,
  postingProblems,
  toTemplateLines,
  type EntryLine,
} from '@kantora/domain';
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
  needs: z
    .object({ counterparty: z.boolean(), document: z.boolean(), costObject: z.boolean() })
    .default({ counterparty: false, document: false, costObject: false }),
});

export async function createAccount(input: z.input<typeof NewAccount>): Promise<Result> {
  const scope = await companyScope('company.edit');
  if ('error' in scope) return { error: scope.error };
  const p = NewAccount.safeParse(input);
  if (!p.success) return { error: p.error.issues[0]?.message ?? 'Невалидни данни.' };
  try {
    await withTenant(appPool, scope.tenant, (c) =>
      c.query(
        `INSERT INTO app.account (office_id, company_id, code, name, is_postable,
                                  needs_counterparty, needs_document, needs_cost_object)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          scope.tenant.officeId,
          scope.tenant.companyId,
          p.data.code,
          p.data.name,
          p.data.isPostable,
          p.data.needs.counterparty,
          p.data.needs.document,
          p.data.needs.costObject,
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
        counterpartyId: z.union([z.uuid(), z.literal('')]).default(''),
        documentNumber: z
          .string()
          .trim()
          .max(50, 'Номерът на документа е до 50 знака.')
          .default(''),
        documentDate: z.union([z.iso.date(), z.literal('')]).default(''),
        costObjectId: z.union([z.uuid(), z.literal('')]).default(''),
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
  input: z.input<typeof EntryInput>,
): Promise<Result<{ id: string; number: number }>> {
  const scope = await companyScope('accounting.post');
  if ('error' in scope) return { error: scope.error };
  const parsed = EntryInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Невалидни данни.' };
  const data = parsed.data;

  type Line = EntryLine & {
    accountId: string;
    description: string;
    counterpartyId: string | null;
    documentNumber: string | null;
    documentDate: string | null;
    costObjectId: string | null;
  };
  const lines: Line[] = [];
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
      counterpartyId: l.counterpartyId || null,
      documentNumber: l.documentNumber || null,
      documentDate: l.documentDate || null,
      costObjectId: l.costObjectId || null,
    });
  });
  problems.push(...postingProblems(lines).map((p) => p.message));
  if (problems.length) return { error: 'Статията не е осчетоводена.', problems };

  try {
    return await withTenant(appPool, scope.tenant, async (c) => {
      // The accounts' analytic needs, read in the same transaction as the insert.
      const needs = new Map(
        (
          await c.query<{
            id: string;
            needs_counterparty: boolean;
            needs_document: boolean;
            needs_cost_object: boolean;
          }>(
            'SELECT id, needs_counterparty, needs_document, needs_cost_object FROM app.account WHERE id = ANY($1)',
            [lines.map((l) => l.accountId)],
          )
        ).rows.map((a) => [
          a.id,
          {
            counterparty: a.needs_counterparty,
            document: a.needs_document,
            costObject: a.needs_cost_object,
          },
        ]),
      );
      const missing = analyticsProblems(
        lines.map((l) => ({
          ...l,
          needs: needs.get(l.accountId) ?? {
            counterparty: false,
            document: false,
            costObject: false,
          },
        })),
      );
      if (missing.length) {
        return { error: 'Статията не е осчетоводена.', problems: missing.map((p) => p.message) };
      }
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
          `INSERT INTO app.journal_line (office_id, company_id, entry_id, line_no, account_id, side,
                                         amount, description, counterparty_id, document_number,
                                         document_date, cost_object_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            scope.tenant.officeId,
            scope.tenant.companyId,
            id,
            ++n,
            l.accountId,
            l.side,
            l.amount,
            l.description,
            l.counterpartyId,
            l.documentNumber,
            l.documentDate,
            l.costObjectId,
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
// Entry templates
// ---------------------------------------------------------------------------
const TemplateInput = z.object({
  name: z.string().trim().min(1, 'Въведете име на шаблона.').max(120, 'Името е твърде дълго.'),
  description: z.string().trim().max(500),
  rows: z
    .array(
      z.object({
        accountId: z.union([z.uuid(), z.literal('')]),
        debit: z.string().max(40),
        credit: z.string().max(40),
        memo: z.string().max(500),
      }),
    )
    .max(500),
});

/** Saves the grid as a template. Amounts are optional; 0 marks the side only. */
export async function saveTemplate(
  input: z.infer<typeof TemplateInput>,
): Promise<Result<{ id: string }>> {
  const scope = await companyScope('accounting.post');
  if ('error' in scope) return { error: scope.error };
  const parsed = TemplateInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Невалидни данни.' };
  const lines = toTemplateLines(parsed.data.rows);
  if (!lines.ok) return { error: 'Шаблонът не е запазен.', problems: lines.problems };
  const { officeId, companyId } = scope.tenant;
  try {
    return await withTenant(appPool, scope.tenant, async (c) => {
      const t = await c.query<{ id: string }>(
        `INSERT INTO app.entry_template (office_id, company_id, name, description)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [officeId, companyId, parsed.data.name, parsed.data.description],
      );
      const id = t.rows[0]?.id;
      if (!id) throw new Error('entry_template insert returned no id');
      let n = 0;
      for (const l of lines.lines) {
        await c.query(
          `INSERT INTO app.entry_template_line
             (office_id, company_id, template_id, line_no, account_id, side, amount, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [officeId, companyId, id, ++n, l.accountId, l.side, l.amount, l.description],
        );
      }
      return { id };
    });
  } catch (err) {
    const e = dbError(err);
    return e.error === 'Такъв запис вече съществува.'
      ? { error: `Шаблон с име „${parsed.data.name}“ вече има.` }
      : e;
  }
}

export async function deleteTemplate(templateId: string): Promise<Result> {
  const scope = await companyScope('accounting.post');
  if ('error' in scope) return { error: scope.error };
  const id = z.uuid().safeParse(templateId);
  if (!id.success) return { error: 'Невалиден шаблон.' };
  try {
    const n = await withTenant(
      appPool,
      scope.tenant,
      async (c) =>
        (await c.query('DELETE FROM app.entry_template WHERE id = $1', [id.data])).rowCount,
    );
    return n ? {} : { error: 'Шаблонът не е намерен.' };
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
