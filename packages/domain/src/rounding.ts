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

/** Formats a Decimal as a fixed 2-decimal string for storage/transport (numeric(19,2)). */
export function toMoneyString(value: Decimal): string {
  return value.toFixed(2);
}
