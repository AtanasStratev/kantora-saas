import { describe, expect, it } from 'vitest';
import { formatAmount, formatDate, parseAmount, parseQuickDate } from './input-format';

const ok = (r: ReturnType<typeof parseAmount>) => (r.ok ? r.value : `ERR: ${r.error}`);

describe('parseAmount', () => {
  it.each([
    ['1 234,56', '1234.56'],
    ['1 234,56', '1234.56'],
    ['1 234,56', '1234.56'],
    ['1234.56', '1234.56'],
    ['1234,56', '1234.56'],
    ['1.234,56', '1234.56'],
    ['1,234.56', '1234.56'],
    ['1.234.567', '1234567'],
    ['-12', '-12'],
    ['+5', '5'],
    [',5', '0.5'],
    ['0', '0'],
    ['-0,00', '0.00'],
    ['100', '100'],
  ])('%s → %s', (input, expected) => {
    expect(ok(parseAmount(input))).toBe(expected);
  });

  it('rejects more than 2 decimals for money, with an explanation', () => {
    const r = parseAmount('1,234');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/най-много 2 знака/);
  });

  it('allows more decimals when asked (quantities, rates)', () => {
    expect(ok(parseAmount('1,2345', 4))).toBe('1.2345');
  });

  it.each(['', '   ', 'abc', '12a', '1-2', '--5'])('rejects %j', (input) => {
    expect(parseAmount(input).ok).toBe(false);
  });
});

describe('formatAmount', () => {
  it.each([
    ['1234.56', '1 234,56'],
    ['1234567.8', '1 234 567,80'],
    ['-1234.5', '-1 234,50'],
    ['0', '0,00'],
    ['-0', '0,00'],
    ['999', '999,00'],
  ])('%s → %s', (input, expected) => {
    expect(formatAmount(input)).toBe(expected);
  });

  it('round-trips through parseAmount', () => {
    for (const v of ['0.01', '-98765.43', '1000000.00']) {
      expect(ok(parseAmount(formatAmount(v)))).toBe(v);
    }
  });
});

describe('parseQuickDate', () => {
  const nov = { year: 2026, month: 11, today: '2026-11-21' };
  const val = (s: string, ctx = nov) => {
    const r = parseQuickDate(s, ctx);
    return r.ok ? r.value : `ERR: ${r.error}`;
  };

  it('"15" is the 15th of the current period', () => {
    expect(val('15')).toBe('2026-11-15');
    expect(val('1')).toBe('2026-11-01');
  });

  it('day+month forms use the period year', () => {
    expect(val('1511')).toBe('2026-11-15');
    expect(val('15.11')).toBe('2026-11-15');
    expect(val('3/2')).toBe('2026-02-03');
  });

  it('full dates with 2- or 4-digit years', () => {
    expect(val('15.11.2026')).toBe('2026-11-15');
    expect(val('31.12.25')).toBe('2025-12-31');
  });

  it('relative and today', () => {
    expect(val('+1')).toBe('2026-11-22');
    expect(val('-21')).toBe('2026-10-31');
    expect(val('д')).toBe('2026-11-21');
  });

  it('29 February only in leap years', () => {
    expect(val('29.02.2028')).toBe('2028-02-29');
    expect(val('29.02.2026')).toMatch(/^ERR: 02\.2026 има 28 дни/);
    expect(val('29', { year: 2024, month: 2, today: '2024-02-10' })).toBe('2024-02-29');
  });

  it('year change: the last day of the pre-euro year and the first euro day', () => {
    expect(val('31', { year: 2025, month: 12, today: '2026-01-05' })).toBe('2025-12-31');
    expect(val('-5', { year: 2026, month: 1, today: '2026-01-05' })).toBe('2025-12-31');
  });

  it('rejects invalid input with a human message', () => {
    expect(val('32')).toMatch(/^ERR: 11\.2026 има 30 дни/);
    expect(val('15.13')).toMatch(/^ERR: Няма месец 13/);
    expect(val('abc')).toMatch(/^ERR: Неразпозната дата/);
    expect(val('')).toMatch(/^ERR: Въведете дата/);
  });
});

describe('formatDate', () => {
  it('formats ISO as dd.mm.yyyy', () => {
    expect(formatDate('2026-02-03')).toBe('03.02.2026');
  });
});
