import { describe, expect, it } from 'vitest';
import {
  postingProblems,
  reversalLines,
  trialBalance,
  type EntryLine,
  type PostedLine,
} from './journal';

// Account codes below are illustrative test data, not a prescribed chart of accounts.
const l = (accountCode: string, side: 'D' | 'C', amount: string): EntryLine => ({
  accountCode,
  side,
  amount,
});
const codes = (lines: EntryLine[]) => postingProblems(lines).map((p) => p.code);

describe('postingProblems', () => {
  it('accepts a balanced entry', () => {
    expect(codes([l('601', 'D', '100.00'), l('401', 'C', '100.00')])).toEqual([]);
    expect(
      codes([l('602', 'D', '83.33'), l('4531', 'D', '16.67'), l('401', 'C', '100.00')]),
    ).toEqual([]);
  });

  it('rejects an unbalanced entry and says by how much and on which side', () => {
    const p = postingProblems([l('601', 'D', '120.00'), l('401', 'C', '100.00')]);
    expect(p.map((x) => x.code)).toEqual(['UNBALANCED']);
    expect(p[0]!.message).toContain('Разлика 20,00 по дебита');
  });

  it('rejects single-line, one-sided, zero, negative and over-precise amounts', () => {
    expect(codes([l('601', 'D', '1.00')])).toContain('TOO_FEW_LINES');
    expect(codes([l('601', 'D', '1.00'), l('602', 'D', '1.00')])).toContain('NO_CREDIT');
    expect(codes([l('601', 'D', '0.00'), l('401', 'C', '0.00')])).toContain('ZERO_AMOUNT');
    expect(codes([l('601', 'D', '-5.00'), l('401', 'C', '-5.00')])).toContain('BAD_AMOUNT');
    expect(codes([l('601', 'D', '1.005'), l('401', 'C', '1.005')])).toContain('BAD_AMOUNT');
    expect(codes([l('', 'D', '1.00'), l('401', 'C', '1.00')])).toContain('NO_ACCOUNT');
  });

  it('uses exact decimals (0.10 + 0.20 = 0.30, no float error)', () => {
    expect(codes([l('601', 'D', '0.10'), l('602', 'D', '0.20'), l('401', 'C', '0.30')])).toEqual(
      [],
    );
  });
});

describe('reversalLines', () => {
  it('swaps sides and keeps accounts and amounts', () => {
    const orig = [l('601', 'D', '100.00'), l('401', 'C', '100.00')];
    expect(reversalLines(orig)).toEqual([l('601', 'C', '100.00'), l('401', 'D', '100.00')]);
    expect(codes(reversalLines(orig))).toEqual([]);
  });

  it('original + reversal nets every account to zero', () => {
    const orig = [l('602', 'D', '83.33'), l('4531', 'D', '16.67'), l('401', 'C', '100.00')];
    const all: PostedLine[] = [...orig, ...reversalLines(orig)].map((x) => ({
      ...x,
      date: '2026-11-15',
    }));
    expect(trialBalance(all, '2026-11-01', '2026-11-30').totals).toMatchObject({
      closingDebit: '0.00',
      closingCredit: '0.00',
    });
  });
});

describe('trialBalance', () => {
  const posted: PostedLine[] = [
    { accountCode: '501', side: 'D', amount: '1000.00', date: '2026-10-05' },
    { accountCode: '101', side: 'C', amount: '1000.00', date: '2026-10-05' },
    { accountCode: '601', side: 'D', amount: '250.00', date: '2026-11-10' },
    { accountCode: '501', side: 'C', amount: '250.00', date: '2026-11-10' },
    { accountCode: '601', side: 'D', amount: '99.99', date: '2026-12-01' }, // after range
    { accountCode: '501', side: 'C', amount: '99.99', date: '2026-12-01' },
  ];

  it('splits opening, turnover and closing by date (boundaries inclusive)', () => {
    const tb = trialBalance(posted, '2026-11-01', '2026-11-30');
    const r501 = tb.rows.find((r) => r.accountCode === '501')!;
    expect(r501).toEqual({
      accountCode: '501',
      openingDebit: '1000.00',
      openingCredit: '0.00',
      turnoverDebit: '0.00',
      turnoverCredit: '250.00',
      closingDebit: '750.00',
      closingCredit: '0.00',
    });
    const r101 = tb.rows.find((r) => r.accountCode === '101')!;
    expect(r101.openingCredit).toBe('1000.00');
    expect(r101.closingCredit).toBe('1000.00');
  });

  it('reconciles: every column pair balances when all entries balance', () => {
    const tb = trialBalance(posted, '2026-11-01', '2026-11-30');
    expect(tb.totals.openingDebit).toBe(tb.totals.openingCredit);
    expect(tb.totals.turnoverDebit).toBe(tb.totals.turnoverCredit);
    expect(tb.totals.closingDebit).toBe(tb.totals.closingCredit);
  });

  it('reconciles on 2 000 generated balanced entries (property test)', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const accounts = ['101', '302', '401', '411', '4531', '4532', '501', '503', '601', '702'];
    const lines: PostedLine[] = [];
    for (let i = 0; i < 2000; i++) {
      const cents = Math.floor(rnd() * 1_000_000) + 1;
      const amount = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
      const day = String(Math.floor(rnd() * 28) + 1).padStart(2, '0');
      const month = String(Math.floor(rnd() * 12) + 1).padStart(2, '0');
      const date = `2026-${month}-${day}`;
      const d = accounts[Math.floor(rnd() * accounts.length)]!;
      const c = accounts[Math.floor(rnd() * accounts.length)]!;
      lines.push(
        { accountCode: d, side: 'D', amount, date },
        { accountCode: c, side: 'C', amount, date },
      );
    }
    const tb = trialBalance(lines, '2026-04-01', '2026-09-30');
    expect(tb.totals.openingDebit).toBe(tb.totals.openingCredit);
    expect(tb.totals.turnoverDebit).toBe(tb.totals.turnoverCredit);
    expect(tb.totals.closingDebit).toBe(tb.totals.closingCredit);
  });

  it('a year-end date (31.12) belongs to the old year, 01.01 to the new one', () => {
    const lines: PostedLine[] = [
      { accountCode: '501', side: 'D', amount: '1.00', date: '2025-12-31' },
      { accountCode: '101', side: 'C', amount: '1.00', date: '2025-12-31' },
    ];
    expect(
      trialBalance(lines, '2026-01-01', '2026-12-31').rows.find((r) => r.accountCode === '501')!
        .openingDebit,
    ).toBe('1.00');
    expect(
      trialBalance(lines, '2025-12-01', '2025-12-31').rows.find((r) => r.accountCode === '501')!
        .turnoverDebit,
    ).toBe('1.00');
  });

  it('accounts with nothing in or before the range are omitted', () => {
    expect(trialBalance([], '2026-01-01', '2026-12-31').rows).toEqual([]);
  });
});
