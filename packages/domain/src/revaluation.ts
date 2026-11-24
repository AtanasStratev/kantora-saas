/**
 * Revaluation of monetary items in foreign currency at the closing rate (СС 21, т. 3.4 а),
 * 3.5, 4.2; docs/legal/README.md, ADR-0015). Pure: the rates come in as a conversion
 * function, so the same code runs with the published rates in the app and with fixed
 * rates in the tests.
 */
import Decimal from 'decimal.js';

const D = Decimal.clone({ precision: 40 });

/** One position: an account, a currency and the analytics the balance is kept by. */
export type FxPosition = {
  accountId: string;
  accountCode: string;
  currency: string;
  counterpartyId: string | null;
  documentNumber: string | null;
  /** Signed (debit positive), in the currency. */
  currencyBalance: string;
  /** Signed (debit positive), in the ledger currency, as booked so far. */
  ledgerBalance: string;
};

export type FxRevaluationLine = {
  position: FxPosition;
  /** The position's value at the closing rate (signed). */
  revalued: string;
  side: 'D' | 'C';
  /** Positive difference, in the ledger currency. */
  amount: string;
};

export type FxRevaluation = {
  lines: FxRevaluationLine[];
  /** Total of the increases (credited to financial income). */
  gain: string;
  /** Total of the decreases (debited to financial expense). */
  loss: string;
};

/**
 * Lines that bring every position to its value at the closing rate. `toLedger` converts
 * a POSITIVE amount in `currency` to the ledger currency (rounded to the cent). An
 * increase of the signed value (an asset worth more, a liability owed less) is a gain;
 * a decrease is a loss. A position settled in the currency but not in the ledger
 * currency is brought to zero: the settlement difference (СС 21, т. 4.1 а).
 */
export function fxRevaluation(
  positions: readonly FxPosition[],
  toLedger: (currency: string, amount: string) => string,
): FxRevaluation {
  let gain = new D(0);
  let loss = new D(0);
  const lines: FxRevaluationLine[] = [];
  for (const p of positions) {
    const cur = new D(p.currencyBalance);
    const value = cur.isZero() ? new D(0) : new D(toLedger(p.currency, cur.abs().toFixed(2)));
    if (value.isNegative()) throw new Error('toLedger must return a non-negative amount');
    const revalued = cur.isNegative() ? value.negated() : value;
    const diff = revalued.minus(p.ledgerBalance);
    if (diff.isZero()) continue;
    if (diff.isPositive()) gain = gain.plus(diff);
    else loss = loss.plus(diff.abs());
    lines.push({
      position: p,
      revalued: revalued.toFixed(2),
      side: diff.isPositive() ? 'D' : 'C',
      amount: diff.abs().toFixed(2),
    });
  }
  return { lines, gain: gain.toFixed(2), loss: loss.toFixed(2) };
}
