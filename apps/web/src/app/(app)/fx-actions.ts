'use server';
import { formatAmount, parseAmount } from '@kantora/domain';
import { fxPositions, runFxRevaluation } from '@kantora/db';
import { DatabaseError } from 'pg';
import { z } from 'zod';
import { companyScope } from '@/lib/company-scope';
import { appPool } from '@/lib/db';
import { fxConverter, toLedgerCurrency } from '@/lib/fx/rates';

type Result<T = object> = ({ error?: undefined } & T) | { error: string };

/**
 * An amount in a foreign currency, in the ledger currency of the entry date (СС 21,
 * т. 3.1: the central rate of the transaction date). The grid fills it in; the
 * accountant may change it (bought or sold currency is at the bank's rate, т. 3.2–3.3).
 */
export async function convertForEntry(input: {
  date: string;
  currency: string;
  amount: string;
}): Promise<Result<{ result: string; basis: string }>> {
  const scope = await companyScope('accounting.post');
  if ('error' in scope) return { error: scope.error };
  const date = z.iso.date().safeParse(input.date);
  const currency = z
    .string()
    .regex(/^[A-Z]{3}$/)
    .safeParse(input.currency);
  if (!date.success) return { error: 'Първо въведете дата на статията.' };
  if (!currency.success) return { error: 'Валутата е 3 главни букви, напр. USD.' };
  const amt = parseAmount(input.amount);
  if (!amt.ok) return { error: amt.error };
  const r = await toLedgerCurrency(scope.tenant.userId, amt.value, currency.data, date.data);
  if (!r.ok) return { error: r.message };
  const when = r.rateDate ? r.rateDate.split('-').reverse().join('.') : '';
  const src = r.source === 'ecb' ? 'ЕЦБ' : r.source === 'bnb' ? 'БНБ' : '';
  return {
    result: r.result,
    basis: [
      `${formatAmount(amt.value)} ${currency.data} = ${formatAmount(r.result)} ${r.ledgerCurrency}: ${r.basis}`,
      src,
      when,
    ]
      .filter(Boolean)
      .join(', '),
  };
}

/** Posts the revaluation of the period at its closing rates (ADR-0015). */
export async function runRevaluation(input: {
  periodId: string;
  gainAccountId: string;
  lossAccountId: string;
}): Promise<Result<{ entryId: string; number: number }>> {
  const scope = await companyScope('accounting.post');
  if ('error' in scope) return { error: scope.error };
  const p = z
    .object({ periodId: z.uuid(), gainAccountId: z.uuid(), lossAccountId: z.uuid() })
    .safeParse(input);
  if (!p.success) return { error: 'Изберете сметки за положителните и отрицателните разлики.' };
  const read = await fxPositions(appPool, scope.tenant, p.data.periodId);
  if (!read) return { error: 'Периодът не е намерен.' };
  const fx = await fxConverter(
    scope.tenant.userId,
    read.period.endDate,
    read.positions.map((x) => x.currency),
  );
  if (!fx.ok) return { error: fx.message };
  try {
    const r = await runFxRevaluation(appPool, scope.tenant, p.data, fx);
    return r.ok ? { entryId: r.entryId, number: r.number } : { error: r.error };
  } catch (err) {
    if (err instanceof DatabaseError && ['23514', '42501'].includes(err.code ?? '')) {
      return { error: err.message };
    }
    // A currency that appeared after the rates were read (posted meanwhile).
    if (err instanceof Error && err.message.startsWith('no rate for')) {
      return { error: 'Появи се нова валута по време на преоценката. Опитайте отново.' };
    }
    throw err;
  }
}
