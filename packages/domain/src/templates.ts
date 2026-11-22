import Decimal from 'decimal.js';
import { parseAmount } from './input-format';

/** One row of the entry grid as typed (amounts are the user's text). */
export type GridRow = { accountId: string; debit: string; credit: string; memo: string };

/** A saved template line. A null amount means "typed each time". */
export type TemplateLine = {
  accountId: string;
  side: 'D' | 'C';
  amount: string | null;
  description: string;
};

/**
 * Turns grid rows into template lines. Every line needs an account and exactly one side.
 * The side comes from the column that holds a value; 0 in a column marks the side
 * without a fixed amount ("this account is always debited, the amount varies").
 * Empty rows are skipped.
 */
export function toTemplateLines(
  rows: GridRow[],
): { ok: true; lines: TemplateLine[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const lines: TemplateLine[] = [];
  rows.forEach((r, i) => {
    const n = i + 1;
    const d = r.debit.trim();
    const c = r.credit.trim();
    if (!r.accountId && !d && !c && !r.memo.trim()) return;
    if (!r.accountId) {
      problems.push(`Ред ${n}: изберете сметка.`);
      return;
    }
    if (d && c) {
      problems.push(`Ред ${n}: сумата е или в дебит, или в кредит, не в двете.`);
      return;
    }
    if (!d && !c) {
      problems.push(
        `Ред ${n}: въведете сума или 0 в дебит или кредит, за да се знае страната на реда.`,
      );
      return;
    }
    const parsed = parseAmount(d || c);
    if (!parsed.ok) {
      problems.push(`Ред ${n}: ${parsed.error}`);
      return;
    }
    const value = new Decimal(parsed.value);
    if (value.isNegative()) {
      problems.push(`Ред ${n}: сумата не може да е отрицателна.`);
      return;
    }
    lines.push({
      accountId: r.accountId,
      side: d ? 'D' : 'C',
      amount: value.isZero() ? null : value.toFixed(2),
      description: r.memo.trim(),
    });
  });
  if (problems.length === 0 && lines.length < 2) {
    problems.push('Шаблонът трябва да има поне два реда.');
  }
  if (
    problems.length === 0 &&
    (!lines.some((l) => l.side === 'D') || !lines.some((l) => l.side === 'C'))
  ) {
    problems.push('Шаблонът трябва да има поне един ред в дебит и един в кредит.');
  }
  return problems.length ? { ok: false, problems } : { ok: true, lines };
}
