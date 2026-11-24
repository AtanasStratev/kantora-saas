'use server';
import { parseEik, parseVatNumber } from '@kantora/domain';
import { withTenant } from '@kantora/db';
import { DatabaseError } from 'pg';
import { z } from 'zod';
import { companyScope } from '@/lib/company-scope';
import { appPool } from '@/lib/db';

/**
 * Counterparties, cost objects and the analytic needs of an account (ADR-0014). Every
 * action checks the permission here; RLS and the triggers check again in the database.
 */
type Result<T = object> = ({ error?: undefined } & T) | { error: string };

function dbError(err: unknown, duplicate: string): { error: string } {
  if (err instanceof DatabaseError) {
    if (['23514', '22023', '42501'].includes(err.code ?? '')) return { error: err.message };
    if (err.code === '23505') return { error: duplicate };
  }
  throw err;
}

const CounterpartyInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Въведете наименование.')
    .max(200, 'Наименованието е твърде дълго.'),
  eik: z.string().max(40),
  vatNumber: z.string().max(40),
  address: z.string().trim().max(300, 'Адресът е твърде дълъг.'),
});
export type CounterpartyInput = z.infer<typeof CounterpartyInput>;

/** Accountants create counterparties while entering documents (no detour to a manager). */
export async function createCounterparty(
  input: CounterpartyInput,
): Promise<Result<{ id: string; name: string; eik: string | null }>> {
  const scope = await companyScope('accounting.post');
  if ('error' in scope) return { error: scope.error };
  const p = CounterpartyInput.safeParse(input);
  if (!p.success) return { error: p.error.issues[0]?.message ?? 'Невалидни данни.' };
  const eik = parseEik(p.data.eik);
  if (!eik.ok) return { error: eik.error };
  const vat = parseVatNumber(p.data.vatNumber);
  if (!vat.ok) return { error: vat.error };
  try {
    return await withTenant(appPool, scope.tenant, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO app.counterparty (office_id, company_id, name, eik, vat_number, address)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          scope.tenant.officeId,
          scope.tenant.companyId,
          p.data.name,
          eik.value,
          vat.value,
          p.data.address,
        ],
      );
      const id = r.rows[0]?.id;
      if (!id) throw new Error('counterparty insert returned no id');
      return { id, name: p.data.name, eik: eik.value };
    });
  } catch (err) {
    return dbError(err, `Контрагент с ЕИК ${eik.value ?? ''} вече има в тази фирма.`);
  }
}

export async function setCounterpartyActive(id: string, active: boolean): Promise<Result> {
  const scope = await companyScope('accounting.post');
  if ('error' in scope) return { error: scope.error };
  const v = z.uuid().safeParse(id);
  if (!v.success) return { error: 'Невалиден контрагент.' };
  try {
    const n = await withTenant(
      appPool,
      scope.tenant,
      async (c) =>
        (
          await c.query('UPDATE app.counterparty SET is_active = $2 WHERE id = $1', [
            v.data,
            active,
          ])
        ).rowCount,
    );
    return n ? {} : { error: 'Контрагентът не е намерен.' };
  } catch (err) {
    return dbError(err, 'Такъв запис вече съществува.');
  }
}

const CostObjectInput = z.object({
  code: z
    .string()
    .trim()
    .regex(
      /^[0-9A-Za-zА-Яа-я][0-9A-Za-zА-Яа-я./-]{0,29}$/,
      'Кодът е до 30 знака: букви, цифри, точка, тире, наклонена черта.',
    ),
  name: z.string().trim().min(1, 'Въведете наименование.').max(200),
});

export async function createCostObject(input: z.infer<typeof CostObjectInput>): Promise<Result> {
  const scope = await companyScope('company.edit');
  if ('error' in scope) return { error: scope.error };
  const p = CostObjectInput.safeParse(input);
  if (!p.success) return { error: p.error.issues[0]?.message ?? 'Невалидни данни.' };
  try {
    await withTenant(appPool, scope.tenant, (c) =>
      c.query(
        'INSERT INTO app.cost_object (office_id, company_id, code, name) VALUES ($1, $2, $3, $4)',
        [scope.tenant.officeId, scope.tenant.companyId, p.data.code, p.data.name],
      ),
    );
    return {};
  } catch (err) {
    return dbError(err, `Обект с код ${p.data.code} вече има.`);
  }
}

export async function setCostObjectActive(id: string, active: boolean): Promise<Result> {
  const scope = await companyScope('company.edit');
  if ('error' in scope) return { error: scope.error };
  const v = z.uuid().safeParse(id);
  if (!v.success) return { error: 'Невалиден обект.' };
  try {
    const n = await withTenant(
      appPool,
      scope.tenant,
      async (c) =>
        (await c.query('UPDATE app.cost_object SET is_active = $2 WHERE id = $1', [v.data, active]))
          .rowCount,
    );
    return n ? {} : { error: 'Обектът не е намерен.' };
  } catch (err) {
    return dbError(err, 'Такъв запис вече съществува.');
  }
}

const NeedInput = z.object({
  accountId: z.uuid(),
  need: z.enum(['counterparty', 'document', 'cost_object', 'currency']),
  value: z.boolean(),
});

/**
 * Turns an analytic need of an account on or off. It applies to entries posted from now
 * on; entries already posted keep what they have (their analytic report shows a
 * "без …" row for lines without it).
 */
export async function setAccountNeed(input: z.infer<typeof NeedInput>): Promise<Result> {
  const scope = await companyScope('company.edit');
  if ('error' in scope) return { error: scope.error };
  const p = NeedInput.safeParse(input);
  if (!p.success) return { error: 'Невалидни данни.' };
  const column = {
    counterparty: 'needs_counterparty',
    document: 'needs_document',
    cost_object: 'needs_cost_object',
    currency: 'is_currency',
  }[p.data.need]; // fixed column names, never user input
  try {
    const n = await withTenant(
      appPool,
      scope.tenant,
      async (c) =>
        (
          await c.query(`UPDATE app.account SET ${column} = $2 WHERE id = $1`, [
            p.data.accountId,
            p.data.value,
          ])
        ).rowCount,
    );
    return n ? {} : { error: 'Сметката не е намерена.' };
  } catch (err) {
    return dbError(err, 'Такъв запис вече съществува.');
  }
}
