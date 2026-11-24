import { describe, expect, it } from 'vitest';
import {
  BGN_PER_EUR,
  convertBgnToEur,
  convertBgnToEurWages,
  roundHalfUp,
  toMoneyString,
} from './rounding';

const s = (x: Parameters<typeof toMoneyString>[0]) => toMoneyString(x);

describe('roundHalfUp (ЗВЕРБ чл. 13, ал. 1)', () => {
  it('keeps the second digit when the third is < 5', () => {
    expect(s(roundHalfUp('1.234'))).toBe('1.23');
    expect(s(roundHalfUp('690.2440396'))).toBe('690.24');
  });

  it('increases the second digit when the third is ≥ 5', () => {
    expect(s(roundHalfUp('1.235'))).toBe('1.24');
    expect(s(roundHalfUp('1.239'))).toBe('1.24');
    expect(s(roundHalfUp('0.995'))).toBe('1.00');
  });

  it('rounds negative amounts symmetrically (half away from zero)', () => {
    expect(s(roundHalfUp('-1.235'))).toBe('-1.24');
    expect(s(roundHalfUp('-1.234'))).toBe('-1.23');
  });

  it('handles zero and large amounts without float error', () => {
    expect(s(roundHalfUp('0'))).toBe('0.00');
    expect(s(roundHalfUp('99999999999999999.995'))).toBe('100000000000000000.00');
  });

  it('rejects anything that is not a plain decimal string', () => {
    expect(() => roundHalfUp('1,23')).toThrow();
    expect(() => roundHalfUp('abc')).toThrow();
    expect(() => roundHalfUp('')).toThrow();
  });
});

describe('convertBgnToEur (ЗВЕРБ чл. 12–13)', () => {
  it('uses the full fixed rate 1.95583', () => {
    expect(BGN_PER_EUR.toString()).toBe('1.95583');
  });

  it('1 EUR worth of BGN converts back to exactly 1.00 EUR', () => {
    expect(s(convertBgnToEur('1.95583'))).toBe('1.00');
  });

  // 1350 / 1.95583 = 690.2440396…; third decimal 4 → 690.24 (verified against the law text;
  // a web-search summary claiming 690.25 was wrong — see docs/legal/README.md).
  it('golden: 1350.00 BGN → 690.24 EUR', () => {
    expect(s(convertBgnToEur('1350.00'))).toBe('690.24');
  });

  it('golden: 100.00 BGN → 51.13 EUR (100 / 1.95583 = 51.1291…)', () => {
    expect(s(convertBgnToEur('100.00'))).toBe('51.13');
  });

  it('converts 0 and negative balances', () => {
    expect(s(convertBgnToEur('0'))).toBe('0.00');
    expect(s(convertBgnToEur('-1350.00'))).toBe('-690.24');
  });

  it('does not round the rate before dividing (0.01 BGN → 0.01 EUR)', () => {
    // 0.01 / 1.95583 = 0.005113 → third digit 5 → 0.01
    expect(s(convertBgnToEur('0.01'))).toBe('0.01');
  });
});

describe('convertBgnToEurWages (ЗВЕРБ чл. 45, ал. 1)', () => {
  it('golden from the evroto.bg guidelines, т. 4.4: 1024.51 BGN → 523.83 EUR', () => {
    // 1024.51 / 1.95583 = 523.82364… : third decimal 3 > 0 → up
    expect(convertBgnToEurWages('1024.51').toFixed(2)).toBe('523.83');
  });

  it('only the third decimal decides: a zero third decimal leaves the second unchanged', () => {
    // 0.02 / 1.95583 = 0.01022583…: third decimal 0 → 0.01 (a ceiling would give 0.02)
    expect(convertBgnToEurWages('0.02').toFixed(2)).toBe('0.01');
    // 1000.00 / 1.95583 = 511.29188…: third decimal 9 → 511.30
    expect(convertBgnToEurWages('1000.00').toFixed(2)).toBe('511.30');
    // exactly 1.00000 stays 1.00
    expect(convertBgnToEurWages('1.95583').toFixed(2)).toBe('1.00');
  });

  it('is never below the standard conversion and keeps the sign of a credit balance', () => {
    for (const v of ['0.01', '10.00', '653.96', '655.12', '99999.99']) {
      expect(convertBgnToEurWages(v).gte(convertBgnToEur(v))).toBe(true);
    }
    expect(convertBgnToEurWages('-1024.51').toFixed(2)).toBe('-523.83');
  });
});
