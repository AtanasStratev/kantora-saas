/**
 * VAT documents (Phase 3, ADR-0018): purchase and sale invoices, debit and credit notes,
 * and the journal entry each one posts. Pure. No rate, threshold or cell number is in
 * this file: rates arrive as parameters from legal_parameter, accounts from the company's
 * VAT settings.
 */
import Decimal from 'decimal.js';
import type { EntryProblem, Side } from './journal';
import { vatAmount } from './rounding';

const D = Decimal.clone({ precision: 40 });

export type VatDirection = 'purchase' | 'sale';
export type VatDocumentKind = 'invoice' | 'debit_note' | 'credit_note';

export const VAT_KIND_LABEL: Record<VatDocumentKind, string> = {
  invoice: 'Фактура',
  debit_note: 'Дебитно известие',
  credit_note: 'Кредитно известие',
};

export type VatLine = {
  /** Expense/asset account (purchase) or revenue account (sale). */
  accountId: string;
  accountCode: string;
  description: string;
  /** Tax base, positive, 2 decimals. */
  net: string;
  /** legal_parameter key of the rate, e.g. "vat_rate_…". */
  rateKey: string;
  /** The rate in percent valid on the tax event date (from legal_parameter). */
  ratePercent: string;
  /** The VAT of the line: computed, or (purchases) as on the supplier's document. */
  vat: string;
};

export type VatSettings = {
  inputVatAccountId: string | null;
  outputVatAccountId: string | null;
  supplierAccountId: string | null;
  customerAccountId: string | null;
};

export type VatPostingLine = {
  accountId: string;
  side: Side;
  amount: string;
  description: string;
  /** Lines on the counterparty account carry the counterparty and the document. */
  withDocument: boolean;
};

const sum = (xs: readonly string[]) => xs.reduce((s, x) => s.plus(x), new D(0));

export function vatTotals(lines: readonly Pick<VatLine, 'net' | 'vat'>[]) {
  const net = sum(lines.map((l) => l.net));
  const vat = sum(lines.map((l) => l.vat));
  return { net: net.toFixed(2), vat: vat.toFixed(2), gross: net.plus(vat).toFixed(2) };
}

/** The computed VAT of a line (the default in the form). */
export const lineVat = (net: string, ratePercent: string) => vatAmount(net, ratePercent).toFixed(2);

/**
 * Problems that prevent posting: amounts, the VAT of a sale must be the computed one, a
 * purchase may differ from it by at most one cent per line (the supplier's rounding).
 */
export function vatDocumentProblems(
  direction: VatDirection,
  lines: readonly VatLine[],
  settings: VatSettings,
): EntryProblem[] {
  const out: EntryProblem[] = [];
  if (lines.length === 0) out.push({ code: 'NO_LINES', message: 'Документът няма редове.' });
  lines.forEach((l, i) => {
    const n = i + 1;
    if (!/^\d+(\.\d{1,2})?$/.test(l.net) || new D(l.net).isZero()) {
      out.push({ code: 'BAD_NET', message: `Ред ${n}: данъчната основа трябва да е положителна.` });
      return;
    }
    if (!/^\d+(\.\d{1,2})?$/.test(l.vat)) {
      out.push({ code: 'BAD_VAT', message: `Ред ${n}: невалидна сума на ДДС.` });
      return;
    }
    const computed = vatAmount(l.net, l.ratePercent);
    const diff = computed.minus(l.vat).abs();
    if (direction === 'sale' && !diff.isZero()) {
      out.push({
        code: 'VAT_MISMATCH',
        message: `Ред ${n}: ДДС на продажба е ${computed.toFixed(2).replace('.', ',')} (по ставката).`,
      });
    } else if (diff.greaterThan('0.01')) {
      out.push({
        code: 'VAT_MISMATCH',
        message: `Ред ${n}: ДДС се различава от изчисленото (${computed.toFixed(2).replace('.', ',')}) с повече от 1 цент.`,
      });
    }
  });
  const missing =
    direction === 'purchase'
      ? [
          [settings.supplierAccountId, 'сметка за доставчиците'],
          [settings.inputVatAccountId, 'сметка за ДДС за покупките'],
        ]
      : [
          [settings.customerAccountId, 'сметка за клиентите'],
          [settings.outputVatAccountId, 'сметка за ДДС за продажбите'],
        ];
  for (const [id, label] of missing) {
    if (!id) out.push({ code: 'NO_SETTING', message: `В настройките на ДДС липсва ${label}.` });
  }
  return out;
}

/**
 * The journal lines of a document. Purchase: Дт the line accounts (base) and the input VAT
 * account, Кт the supplier account (total). Sale: Дт the customer account (total), Кт the
 * line accounts and the output VAT account. A credit note is the same with the sides
 * swapped. Account NUMBERS are not here: they come from the settings and the lines.
 */
export function vatPostingLines(
  direction: VatDirection,
  kind: VatDocumentKind,
  lines: readonly VatLine[],
  settings: VatSettings,
): VatPostingLine[] {
  const t = vatTotals(lines);
  const flip = kind === 'credit_note';
  const side = (s: Side): Side => (flip ? (s === 'D' ? 'C' : 'D') : s);
  const out: VatPostingLine[] = [];
  if (direction === 'purchase') {
    for (const l of lines) {
      out.push({
        accountId: l.accountId,
        side: side('D'),
        amount: new D(l.net).toFixed(2),
        description: l.description,
        withDocument: false,
      });
    }
    if (!new D(t.vat).isZero() && settings.inputVatAccountId) {
      out.push({
        accountId: settings.inputVatAccountId,
        side: side('D'),
        amount: t.vat,
        description: 'ДДС',
        withDocument: true,
      });
    }
    if (settings.supplierAccountId) {
      out.push({
        accountId: settings.supplierAccountId,
        side: side('C'),
        amount: t.gross,
        description: '',
        withDocument: true,
      });
    }
  } else {
    if (settings.customerAccountId) {
      out.push({
        accountId: settings.customerAccountId,
        side: side('D'),
        amount: t.gross,
        description: '',
        withDocument: true,
      });
    }
    for (const l of lines) {
      out.push({
        accountId: l.accountId,
        side: side('C'),
        amount: new D(l.net).toFixed(2),
        description: l.description,
        withDocument: false,
      });
    }
    if (!new D(t.vat).isZero() && settings.outputVatAccountId) {
      out.push({
        accountId: settings.outputVatAccountId,
        side: side('C'),
        amount: t.vat,
        description: 'ДДС',
        withDocument: true,
      });
    }
  }
  return out;
}
