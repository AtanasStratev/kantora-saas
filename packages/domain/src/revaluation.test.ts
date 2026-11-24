import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { fxRevaluation, type FxPosition } from './revaluation';
import { convertWithBnbRate } from './rounding';

// Rates and account codes are illustrative test data, not published rates or a chart.
const RATES: Record<string, string> = { USD: '1.1000', GBP: '0.8500' };
const toLedger = (c: string, a: string) =>
  convertWithBnbRate(a, { kind: 'per_eur', rate: RATES[c] ?? '1' }).toFixed(2);

const pos = (code: string, currency: string, cur: string, ledger: string): FxPosition => ({
  accountId: code,
  accountCode: code,
  currency,
  counterpartyId: null,
  documentNumber: null,
  currencyBalance: cur,
  ledgerBalance: ledger,
});

describe('fxRevaluation', () => {
  it('an asset worth more is a gain: debit the account', () => {
    // 1100 USD ÷ 1.1000 = 1000.00; booked at 980.00 → +20.00
    const r = fxRevaluation([pos('504', 'USD', '1100.00', '980.00')], toLedger);
    expect(r.lines.map((l) => [l.side, l.amount, l.revalued])).toEqual([['D', '20.00', '1000.00']]);
    expect([r.gain, r.loss]).toEqual(['20.00', '0.00']);
  });

  it('a liability owed more is a loss: credit the account', () => {
    // −1100 USD → −1000.00; booked −950.00 → −50.00
    const r = fxRevaluation([pos('401', 'USD', '-1100.00', '-950.00')], toLedger);
    expect(r.lines.map((l) => [l.side, l.amount, l.revalued])).toEqual([
      ['C', '50.00', '-1000.00'],
    ]);
    expect([r.gain, r.loss]).toEqual(['0.00', '50.00']);
  });

  it('a position settled in the currency is brought to zero (settlement difference)', () => {
    const r = fxRevaluation([pos('401', 'USD', '0.00', '-3.17')], toLedger);
    expect(r.lines.map((l) => [l.side, l.amount, l.revalued])).toEqual([['D', '3.17', '0.00']]);
    expect(r.gain).toBe('3.17');
  });

  it('nothing to do when the booked value is already right; gains and losses are gross', () => {
    const r = fxRevaluation(
      [
        pos('504', 'USD', '1100.00', '1000.00'),
        pos('504', 'GBP', '850.00', '990.00'), // 1000.00 → +10.00
        pos('401', 'GBP', '-85.00', '-90.00'), // −100.00 → −10.00
      ],
      toLedger,
    );
    expect(r.lines.map((l) => [l.position.currency, l.side, l.amount])).toEqual([
      ['GBP', 'D', '10.00'],
      ['GBP', 'C', '10.00'],
    ]);
    expect([r.gain, r.loss]).toEqual(['10.00', '10.00']);
  });

  it('after posting the lines every position equals its revalued value (Dt = Кт with gain/loss)', () => {
    const ps = [
      pos('504', 'USD', '1234.56', '1100.10'),
      pos('401', 'USD', '-77.77', '-70.00'),
      pos('411', 'GBP', '333.33', '400.00'),
    ];
    const r = fxRevaluation(ps, toLedger);
    for (const l of r.lines) {
      const after = new Decimal(l.position.ledgerBalance).plus(
        l.side === 'D' ? l.amount : `-${l.amount}`,
      );
      expect(after.toFixed(2)).toBe(l.revalued);
    }
    const d = r.lines
      .filter((l) => l.side === 'D')
      .reduce((s, l) => s.plus(l.amount), new Decimal(0));
    const c = r.lines
      .filter((l) => l.side === 'C')
      .reduce((s, l) => s.plus(l.amount), new Decimal(0));
    // The account lines plus loss (debit) and gain (credit) balance.
    expect(d.plus(r.loss).toFixed(2)).toBe(c.plus(r.gain).toFixed(2));
  });
});
