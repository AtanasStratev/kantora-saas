import { describe, expect, it } from 'vitest';
import { toTemplateLines, type GridRow } from './templates';

const row = (accountId: string, debit = '', credit = '', memo = ''): GridRow => ({
  accountId,
  debit,
  credit,
  memo,
});

describe('toTemplateLines', () => {
  it('keeps fixed amounts and turns 0 into "side only"', () => {
    const r = toTemplateLines([row('a', '1 234,5'), row('b', '', '0', ' наем '), row('')]);
    expect(r).toEqual({
      ok: true,
      lines: [
        { accountId: 'a', side: 'D', amount: '1234.50', description: '' },
        { accountId: 'b', side: 'C', amount: null, description: 'наем' },
      ],
    });
  });

  it('explains every bad row', () => {
    const r = toTemplateLines([row('a'), row('', '5'), row('c', '1', '2'), row('d', 'x')]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toEqual([
      'Ред 1: въведете сума или 0 в дебит или кредит, за да се знае страната на реда.',
      'Ред 2: изберете сметка.',
      'Ред 3: сумата е или в дебит, или в кредит, не в двете.',
      'Ред 4: Сумата може да съдържа само цифри, запетая или точка.',
    ]);
  });

  it('refuses negative amounts, a single line, and one-sided templates', () => {
    const neg = toTemplateLines([row('a', '-5'), row('b', '', '5')]);
    expect(neg.ok ? [] : neg.problems).toEqual(['Ред 1: сумата не може да е отрицателна.']);
    const one = toTemplateLines([row('a', '5')]);
    expect(one.ok ? [] : one.problems).toEqual(['Шаблонът трябва да има поне два реда.']);
    const side = toTemplateLines([row('a', '5'), row('b', '0')]);
    expect(side.ok ? [] : side.problems).toEqual([
      'Шаблонът трябва да има поне един ред в дебит и един в кредит.',
    ]);
  });

  it('does not require the template to balance (amounts may be typed later)', () => {
    expect(toTemplateLines([row('a', '100'), row('b', '', '0')]).ok).toBe(true);
  });
});
