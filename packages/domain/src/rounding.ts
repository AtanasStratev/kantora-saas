/**
 * The ONLY place in the codebase where monetary rounding happens (ADR-0004, PROMPT.md 3.3).
 *
 * Legal source: Закон за въвеждане на еврото в Република България (ЗВЕРБ), чл. 12–13,
 * consolidated text in docs/legal/euro/ZVERB-justice-bg.pdf (verified 2026-11-14).
 */
import Decimal from 'decimal.js';

/** Isolated Decimal constructor so global Decimal settings elsewhere cannot affect us. */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type DecimalInput = string | Decimal;

/**
 * Fixed conversion rate 1 EUR = 1.95583 BGN: Council Regulation (EU) 2025/1409, Art. 1
 * (in force 1 January 2026). Mirrors legal_parameter 'eur_bgn_conversion_rate'; an
 * integration test fails if the two ever differ. ЗВЕРБ чл. 12, ал. 1–2: used with all six
 * significant digits, never rounded or truncated.
 */
export const BGN_PER_EUR = new D('1.95583');

function toDecimal(value: DecimalInput): Decimal {
  if (typeof value === 'string') {
    // Accept only plain decimal strings ("-1234.56"); locale parsing lives in the UI layer.
    if (!/^-?\d+(\.\d+)?$/.test(value)) {
      throw new Error(`Invalid decimal string: "${value}"`);
    }
  }
  return new D(value);
}

/**
 * Rounds to `places` decimals, half away from zero, based on the next digit
 * (ЗВЕРБ чл. 13, ал. 1: third digit < 5 → unchanged; ≥ 5 → second digit + 1).
 * For negative amounts the magnitude is rounded the same way (-0.005 → -0.01).
 */
export function roundHalfUp(value: DecimalInput, places = 2): Decimal {
  return toDecimal(value).toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
}

/**
 * Converts a BGN amount to EUR per ЗВЕРБ чл. 12–13:
 * divide by the full rate 1.95583 (no intermediate rounding), then round to 2 decimals.
 */
export function convertBgnToEur(bgn: DecimalInput): Decimal {
  return roundHalfUp(toDecimal(bgn).dividedBy(BGN_PER_EUR), 2);
}

/**
 * Converts wages and the other amounts of ЗВЕРБ чл. 45, ал. 1–2 (also as balances,
 * чл. 48, ал. 2): divide by the full rate (чл. 12), then, "if the third decimal is greater
 * than zero, the second decimal is increased by one unit". Only the third decimal decides
 * (523.82364 → 523.83; 0.0102258… → 0.01). The magnitude is rounded; the sign is kept.
 */
export function convertBgnToEurWages(bgn: DecimalInput): Decimal {
  const exact = toDecimal(bgn).dividedBy(BGN_PER_EUR);
  const third = exact.abs().toDecimalPlaces(3, Decimal.ROUND_DOWN);
  const two = exact.abs().toDecimalPlaces(2, Decimal.ROUND_DOWN);
  const up = third.minus(two).gt(0) ? two.plus('0.01') : two;
  return exact.isNegative() ? up.negated() : up;
}

/** How a BNB central rate is quoted (docs/legal/README.md, „Курсове на БНБ: формат“). */
export type BnbQuote =
  /** From 1.01.2026: units of the currency for 1 EUR (the euro's rate to the currency). */
  | { kind: 'per_eur'; rate: string }
  /** Until 31.12.2025: BGN for `units` units of the currency. */
  | { kind: 'bgn_per_units'; rate: string; units: number };

/**
 * A foreign-currency amount in the ledger currency with the BNB central rate of the
 * transaction date (ЗСч чл. 5, ал. 1). The published rate is used as it is, without
 * intermediate rounding; the result is rounded to the cent, half up. The law requires
 * amounts in cents (ЗДДС чл. 26, ал. 2: „в евро и евроцентове“) but sets the method only
 * for BGN → EUR (ЗВЕРБ чл. 13; Reg. 1103/97 art. 5: nearest cent); the same method is used
 * here (docs/legal/README.md).
 */
export function convertWithBnbRate(amount: DecimalInput, quote: BnbQuote): Decimal {
  const a = toDecimal(amount);
  const rate = toDecimal(quote.rate);
  if (!rate.gt(0)) throw new Error('A BNB rate must be positive'); // isPositive() is true for 0
  if (quote.kind === 'per_eur') return roundHalfUp(a.dividedBy(rate), 2);
  if (!Number.isInteger(quote.units) || quote.units < 1) {
    throw new Error('Units of a BNB rate must be a positive integer');
  }
  return roundHalfUp(a.times(rate).dividedBy(quote.units), 2);
}

/**
 * An amount from a numeric Excel cell. Excel stores binary floating point, so 1234.56 can
 * arrive as "1234.5599999999999". Such a value is the 2-decimal amount it displays when it
 * is within 1e-9 of it; anything else really has more than 2 decimals and is refused (null)
 * rather than silently rounded.
 */
export function excelNumberToMoney(raw: string): string | null {
  let v: Decimal;
  try {
    v = new D(raw.trim());
  } catch {
    return null;
  }
  if (!v.isFinite()) return null;
  const cents = v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return cents.minus(v).abs().lt('1e-9') ? cents.toFixed(2) : null;
}

/** Formats a Decimal as a fixed 2-decimal string for storage/transport (numeric(19,2)). */
export function toMoneyString(value: Decimal): string {
  return value.toFixed(2);
}
