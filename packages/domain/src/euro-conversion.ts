/**
 * Conversion of the BGN closing balances into EUR opening balances on the euro
 * introduction date (ADR-0016; ЗВЕРБ чл. 48, docs/legal/README.md):
 *   - every position (asset or liability, kept by its analytics) is converted on its own
 *     (чл. 48, ал. 2), wages by чл. 45 (rounded up from the third decimal);
 *   - the converted positions no longer add up to zero; the difference is the sum of the
 *     rounding of each position. The part of the equity accounts stays in equity
 *     (чл. 48, ал. 6); the rest is current income or expense (чл. 48, ал. 4).
 * All rounding is in rounding.ts.
 */
import Decimal from 'decimal.js';
import { BGN_PER_EUR, convertBgnToEur, convertBgnToEurWages, roundHalfUp } from './rounding';

const D = Decimal.clone({ precision: 40 });

export type EuroConversionClass = 'standard' | 'equity' | 'wages';

export type BgnPosition<K> = {
  key: K;
  accountCode: string;
  cls: EuroConversionClass;
  /** Signed closing balance in BGN (debit positive). */
  bgn: string;
};

export type EuroConversion<K> = {
  lines: { key: K; accountCode: string; eur: string }[];
  /**
   * Signed amounts that balance the entry: `equity` on the chosen equity account,
   * `result` on income (negative = credit, a gain) or expense (positive = debit, a loss).
   */
  equity: string;
  result: string;
};

export function euroConversion<K>(positions: readonly BgnPosition<K>[]): EuroConversion<K> {
  let total = new D(0); // sum of the converted signed balances
  let equityRounding = new D(0); // exact rounding of the equity positions
  let bgnTotal = new D(0);
  const lines: EuroConversion<K>['lines'] = [];
  for (const p of positions) {
    const bgn = new D(p.bgn);
    bgnTotal = bgnTotal.plus(bgn);
    if (bgn.isZero()) continue;
    const eur = p.cls === 'wages' ? convertBgnToEurWages(p.bgn) : convertBgnToEur(p.bgn);
    total = total.plus(eur);
    if (p.cls === 'equity') {
      equityRounding = equityRounding.plus(eur.minus(bgn.dividedBy(BGN_PER_EUR)));
    }
    if (!eur.isZero()) lines.push({ key: p.key, accountCode: p.accountCode, eur: eur.toFixed(2) });
  }
  if (!bgnTotal.isZero()) {
    throw new Error(`BGN balances do not add up to zero (${bgnTotal.toFixed(2)})`);
  }
  // The entry needs −total; the equity part of it stays in equity.
  const equity = roundHalfUp(equityRounding.negated(), 2);
  const result = total.negated().minus(equity);
  return { lines, equity: equity.toFixed(2), result: result.toFixed(2) };
}
