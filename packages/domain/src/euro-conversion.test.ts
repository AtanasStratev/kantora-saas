import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { euroConversion, type BgnPosition } from './euro-conversion';

// Account codes and balances are illustrative test data, not a prescribed chart.
const p = (code: string, bgn: string, cls: BgnPosition<string>['cls'] = 'standard') => ({
  key: `${code}:${bgn}`,
  accountCode: code,
  cls,
  bgn,
});
const sum = (xs: string[]) => xs.reduce((s, x) => s.plus(x), new Decimal(0));

describe('euroConversion (ЗВЕРБ чл. 48)', () => {
  it('converts every position on its own and balances the entry with the rounding', () => {
    // 653.96 → 334.36 ; 655.12 → 334.96 (the guidelines' examples), cash −1309.08 → −669.32
    const r = euroConversion([
      p('302', '653.96'),
      p('304', '655.12'),
      p('101', '-1309.08', 'equity'),
    ]);
    expect(r.lines.map((l) => [l.accountCode, l.eur])).toEqual([
      ['302', '334.36'],
      ['304', '334.96'],
      ['101', '-669.32'],
    ]);
    // Converted: 334.36 + 334.96 − 669.32 = 0.00 → nothing to balance
    expect([r.equity, r.result]).toEqual(['0.00', '0.00']);
  });

  it('the equity rounding stays in equity, the rest goes to income or expense', () => {
    const r = euroConversion([
      p('501', '0.03'), // 0.015338… → 0.02 (+0.00466)
      p('101', '-0.01', 'equity'), // −0.005112… → −0.01 (−0.00489)
      p('111', '-0.01', 'equity'),
      p('112', '-0.01', 'equity'),
    ]);
    // converted total 0.02 − 0.03 = −0.01 → the entry needs +0.01;
    // equity rounding −0.01467 → equity line +0.01; nothing left for the result
    expect([r.equity, r.result]).toEqual(['0.01', '0.00']);
    const r2 = euroConversion([p('501', '0.01'), p('502', '0.01'), p('101', '-0.02', 'equity')]);
    // 0.01 + 0.01 − 0.01 = +0.01; equity rounding +0.00023 → 0.00; result −0.01 (a gain)
    expect([r2.equity, r2.result]).toEqual(['0.00', '-0.01']);
  });

  it('wages are rounded up from the third decimal (чл. 45), the difference is an expense', () => {
    const r = euroConversion([p('421', '-1024.51', 'wages'), p('503', '1024.51')]);
    // −523.83 (wages) + 523.82 (bank, 523.82364 → 523.82) = −0.01 → a debit of 0.01 (loss)
    expect(r.lines.map((l) => l.eur)).toEqual(['-523.83', '523.82']);
    expect([r.equity, r.result]).toEqual(['0.00', '0.01']);
  });

  it('every entry balances on many random positions', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 50; round++) {
      const ps: BgnPosition<string>[] = [];
      let bal = new Decimal(0);
      for (let i = 0; i < 40; i++) {
        const v = new Decimal(Math.floor(rnd() * 2_000_000) - 1_000_000).div(100);
        bal = bal.plus(v);
        const cls = rnd() < 0.2 ? 'equity' : rnd() < 0.2 ? 'wages' : 'standard';
        ps.push(p(`${i}`, v.toFixed(2), cls));
      }
      ps.push(p('x', bal.negated().toFixed(2)));
      const r = euroConversion(ps);
      expect(sum([...r.lines.map((l) => l.eur), r.equity, r.result]).toFixed(2)).toBe('0.00');
      expect(new Decimal(r.equity).abs().lte('1')).toBe(true);
    }
  });

  it('refuses balances that do not add up to zero', () => {
    expect(() => euroConversion([p('501', '10.00')])).toThrow(/do not add up to zero/);
  });
});
