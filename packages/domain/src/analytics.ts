/**
 * Analytics (ADR-0014): what an account needs on each line (counterparty, document, cost
 * object), the input rules for counterparties, and the analytic balance used to reconcile
 * analytic reports with the trial balance. The database enforces the same needs on
 * posting (migration 20261124100000); these give precise messages first.
 */
import Decimal from 'decimal.js';
import type { EntryProblem, Side } from './journal';

const D = Decimal.clone({ precision: 40 });

export type AnalyticNeeds = { counterparty: boolean; document: boolean; costObject: boolean };
export const NO_NEEDS: AnalyticNeeds = { counterparty: false, document: false, costObject: false };

export type AnalyticLine = {
  accountCode: string;
  needs: AnalyticNeeds;
  counterpartyId?: string | null;
  documentNumber?: string | null;
  documentDate?: string | null;
  costObjectId?: string | null;
};

/** Problems that prevent posting because of missing analytics; same wording as the DB. */
export function analyticsProblems(lines: readonly AnalyticLine[]): EntryProblem[] {
  const out: EntryProblem[] = [];
  lines.forEach((l, i) => {
    const n = i + 1;
    if (l.needs.counterparty && !l.counterpartyId) {
      out.push({
        code: 'NO_COUNTERPARTY',
        message: `Ред ${n}: сметка ${l.accountCode} изисква контрагент.`,
      });
    }
    if (l.needs.document && !l.documentNumber?.trim()) {
      out.push({
        code: 'NO_DOCUMENT',
        message: `Ред ${n}: сметка ${l.accountCode} изисква номер на документ.`,
      });
    }
    if (l.documentDate && !l.documentNumber?.trim()) {
      out.push({
        code: 'DOCUMENT_DATE_WITHOUT_NUMBER',
        message: `Ред ${n}: има дата на документ без номер.`,
      });
    }
    if (l.needs.costObject && !l.costObjectId) {
      out.push({
        code: 'NO_COST_OBJECT',
        message: `Ред ${n}: сметка ${l.accountCode} изисква обект.`,
      });
    }
  });
  return out;
}

type Parsed = { ok: true; value: string | null } | { ok: false; error: string };

/**
 * EIK as typed: spaces removed, empty → none. Format only (9 or 13 digits); the check
 * digit waits for its official source (docs/legal/README.md).
 */
export function parseEik(text: string): Parsed {
  const v = text.replace(/\s+/g, '');
  if (!v) return { ok: true, value: null };
  if (!/^(\d{9}|\d{13})$/.test(v)) {
    return { ok: false, error: 'ЕИК е 9 цифри (или 13 за клон).' };
  }
  return { ok: true, value: v };
}

/** VAT number as typed: spaces removed, upper case; shape only (VIES is a later step). */
export function parseVatNumber(text: string): Parsed {
  const v = text.replace(/\s+/g, '').toUpperCase();
  if (!v) return { ok: true, value: null };
  if (!/^[A-Z]{2}[0-9A-Z]{2,13}$/.test(v)) {
    return { ok: false, error: 'ДДС номерът започва с кода на държавата, напр. BG и цифрите.' };
  }
  return { ok: true, value: v };
}

export type KeyedLine = { key: string; date: string; side: Side; amount: string };
export type AnalyticRow = {
  key: string;
  opening: string; // signed: debit positive
  debit: string;
  credit: string;
  closing: string; // signed
};

/**
 * Balance per analytic key (counterparty, document, object) for [from, to]: opening from
 * everything before `from`. Signed, because a counterparty's balance is read as "owes /
 * is owed" on one account. Keys with nothing at all are left out.
 */
export function analyticBalance(
  lines: readonly KeyedLine[],
  from: string,
  to: string,
): AnalyticRow[] {
  const m = new Map<string, { o: Decimal; d: Decimal; c: Decimal }>();
  for (const l of lines) {
    if (l.date > to) continue;
    let a = m.get(l.key);
    if (!a) m.set(l.key, (a = { o: new D(0), d: new D(0), c: new D(0) }));
    const amt = new D(l.amount);
    if (l.date < from) a.o = l.side === 'D' ? a.o.plus(amt) : a.o.minus(amt);
    else if (l.side === 'D') a.d = a.d.plus(amt);
    else a.c = a.c.plus(amt);
  }
  return [...m.entries()]
    .map(([key, a]) => ({
      key,
      opening: a.o.toFixed(2),
      debit: a.d.toFixed(2),
      credit: a.c.toFixed(2),
      closing: a.o.plus(a.d).minus(a.c).toFixed(2),
    }))
    .filter((r) => [r.opening, r.debit, r.credit, r.closing].some((v) => v !== '0.00'))
    .sort((x, y) => x.key.localeCompare(y.key));
}
