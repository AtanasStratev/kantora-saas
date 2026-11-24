'use server';
import { runEuroConversion, withTenant } from '@kantora/db';
import { DatabaseError } from 'pg';
import { z } from 'zod';
import { companyScope } from '@/lib/company-scope';
import { appPool } from '@/lib/db';

/** BGN → EUR conversion of the balances (ADR-0016). Owner and chief accountant only. */
type Result<T = object> = ({ error?: undefined } & T) | { error: string };

function dbError(err: unknown): { error: string } {
  if (err instanceof DatabaseError && ['23514', '22023', '42501'].includes(err.code ?? '')) {
    return { error: err.message };
  }
  throw err;
}

/** The BGN year before the first EUR year, with its 12 periods. */
export async function addPreviousYear(year: number): Promise<Result> {
  const scope = await companyScope('company.edit');
  if ('error' in scope) return { error: scope.error };
  const y = z.number().int().min(2000).max(2025).safeParse(year);
  if (!y.success) return { error: 'Невалидна година.' };
  try {
    await withTenant(appPool, scope.tenant, (c) =>
      c.query('SELECT app.add_fiscal_year($1)', [y.data]),
    );
    return {};
  } catch (err) {
    return dbError(err);
  }
}

/** How an account's balances are converted: standard, equity (чл. 48, ал. 6), wages (чл. 45). */
export async function setConversionClass(
  accountId: string,
  cls: 'standard' | 'equity' | 'wages',
): Promise<Result> {
  const scope = await companyScope('company.edit');
  if ('error' in scope) return { error: scope.error };
  const p = z
    .object({ id: z.uuid(), cls: z.enum(['standard', 'equity', 'wages']) })
    .safeParse({ id: accountId, cls });
  if (!p.success) return { error: 'Невалидни данни.' };
  try {
    const n = await withTenant(
      appPool,
      scope.tenant,
      async (c) =>
        (
          await c.query('UPDATE app.account SET euro_conversion = $2 WHERE id = $1', [
            p.data.id,
            p.data.cls,
          ])
        ).rowCount,
    );
    return n ? {} : { error: 'Сметката не е намерена.' };
  } catch (err) {
    return dbError(err);
  }
}

export async function convertToEuro(input: {
  gainAccountId: string;
  lossAccountId: string;
  equityAccountId: string;
}): Promise<Result<{ entryId: string; number: number }>> {
  const scope = await companyScope('company.edit');
  if ('error' in scope) return { error: scope.error };
  const p = z
    .object({ gainAccountId: z.uuid(), lossAccountId: z.uuid(), equityAccountId: z.uuid() })
    .safeParse(input);
  if (!p.success) return { error: 'Изберете трите сметки за разликите.' };
  try {
    const r = await runEuroConversion(appPool, scope.tenant, p.data);
    return r.ok ? { entryId: r.entryId, number: r.number } : { error: r.error };
  } catch (err) {
    return dbError(err);
  }
}
