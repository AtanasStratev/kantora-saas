/**
 * Double-entry core (PROMPT.md 3.3): entry validation, reversal and the trial balance.
 * Pure functions; the database enforces the same rules independently (migration
 * 20261122100000). All amounts are decimal strings in the ledger currency of the year.
 */
import Decimal from 'decimal.js';
import { formatAmount } from './input-format';

const D = Decimal.clone({ precision: 40 });

export type Side = 'D' | 'C';
export type EntryLine = { accountCode: string; side: Side; amount: string };

export type EntryProblem = { code: string; message: string };

/** Problems that prevent posting; an empty list means the entry can be posted. */
export function postingProblems(lines: readonly EntryLine[]): EntryProblem[] {
  const problems: EntryProblem[] = [];
  if (lines.length < 2) {
    problems.push({ code: 'TOO_FEW_LINES', message: 'Статията трябва да има поне два реда.' });
  }
  let debit = new D(0);
  let credit = new D(0);
  lines.forEach((l, i) => {
    const n = i + 1;
    if (!l.accountCode.trim()) {
      problems.push({ code: 'NO_ACCOUNT', message: `Ред ${n}: изберете сметка.` });
    }
    if (!/^\d+(\.\d{1,2})?$/.test(l.amount)) {
      problems.push({
        code: 'BAD_AMOUNT',
        message: `Ред ${n}: сумата трябва да е положително число с до 2 знака след запетаята.`,
      });
      return;
    }
    const a = new D(l.amount);
    if (a.isZero()) {
      problems.push({ code: 'ZERO_AMOUNT', message: `Ред ${n}: сумата не може да е нула.` });
    }
    if (l.side === 'D') debit = debit.plus(a);
    else credit = credit.plus(a);
  });
  if (lines.length >= 2 && !lines.some((l) => l.side === 'D')) {
    problems.push({ code: 'NO_DEBIT', message: 'Статията няма ред по дебита.' });
  }
  if (lines.length >= 2 && !lines.some((l) => l.side === 'C')) {
    problems.push({ code: 'NO_CREDIT', message: 'Статията няма ред по кредита.' });
  }
  if (!debit.equals(credit)) {
    const diff = debit.minus(credit);
    problems.push({
      code: 'UNBALANCED',
      message:
        `Дебитът (${formatAmount(debit)}) не е равен на кредита (${formatAmount(credit)}). ` +
        `Разлика ${formatAmount(diff.abs())} по ${diff.isPositive() ? 'дебита' : 'кредита'}: ` +
        'добавете ред или поправете сумите.',
    });
  }
  return problems;
}

/** Lines of the reversing entry: same accounts and amounts, opposite sides. */
export function reversalLines(lines: readonly EntryLine[]): EntryLine[] {
  return lines.map((l) => ({ ...l, side: l.side === 'D' ? 'C' : 'D' }));
}

/** `opening`: an opening balance line (BGN → EUR conversion): always in the opening balance. */
export type PostedLine = EntryLine & { date: string; opening?: boolean }; // ISO date of the entry

export type TrialBalanceRow = {
  accountCode: string;
  openingDebit: string;
  openingCredit: string;
  turnoverDebit: string;
  turnoverCredit: string;
  closingDebit: string;
  closingCredit: string;
};

export type TrialBalance = {
  rows: TrialBalanceRow[];
  totals: Omit<TrialBalanceRow, 'accountCode'>;
};

/**
 * Оборотна ведомост for [from, to]: opening balance from everything before `from`,
 * turnovers within the range, closing = opening + turnovers. Balances are shown on the
 * side where they are (net), as accountants read them. Only accounts with any amount appear.
 */
export function trialBalance(lines: readonly PostedLine[], from: string, to: string): TrialBalance {
  type Acc = { od: Decimal; oc: Decimal; td: Decimal; tc: Decimal };
  const acc = new Map<string, Acc>();
  const get = (code: string) => {
    let a = acc.get(code);
    if (!a) acc.set(code, (a = { od: new D(0), oc: new D(0), td: new D(0), tc: new D(0) }));
    return a;
  };
  for (const l of lines) {
    if (l.date > to) continue;
    const a = get(l.accountCode);
    const amt = new D(l.amount);
    if (l.date < from || l.opening) {
      if (l.side === 'D') a.od = a.od.plus(amt);
      else a.oc = a.oc.plus(amt);
    } else if (l.side === 'D') a.td = a.td.plus(amt);
    else a.tc = a.tc.plus(amt);
  }
  const net = (d: Decimal, c: Decimal): [Decimal, Decimal] =>
    d.greaterThanOrEqualTo(c) ? [d.minus(c), new D(0)] : [new D(0), c.minus(d)];
  const zero = {
    od: new D(0),
    oc: new D(0),
    td: new D(0),
    tc: new D(0),
    cd: new D(0),
    cc: new D(0),
  };
  const t = { ...zero };
  const rows: TrialBalanceRow[] = [...acc.entries()]
    .sort(([x], [y]) => x.localeCompare(y, 'bg', { numeric: true }))
    .map(([code, a]) => {
      const [od, oc] = net(a.od, a.oc);
      const [cd, cc] = net(a.od.plus(a.td), a.oc.plus(a.tc));
      t.od = t.od.plus(od);
      t.oc = t.oc.plus(oc);
      t.td = t.td.plus(a.td);
      t.tc = t.tc.plus(a.tc);
      t.cd = t.cd.plus(cd);
      t.cc = t.cc.plus(cc);
      return {
        accountCode: code,
        openingDebit: od.toFixed(2),
        openingCredit: oc.toFixed(2),
        turnoverDebit: a.td.toFixed(2),
        turnoverCredit: a.tc.toFixed(2),
        closingDebit: cd.toFixed(2),
        closingCredit: cc.toFixed(2),
      };
    })
    .filter((r) => Object.entries(r).some(([k, v]) => k !== 'accountCode' && v !== '0.00'));
  return {
    rows,
    totals: {
      openingDebit: t.od.toFixed(2),
      openingCredit: t.oc.toFixed(2),
      turnoverDebit: t.td.toFixed(2),
      turnoverCredit: t.tc.toFixed(2),
      closingDebit: t.cd.toFixed(2),
      closingCredit: t.cc.toFixed(2),
    },
  };
}
