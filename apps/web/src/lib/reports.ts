import 'server-only';
import * as q from '@kantora/db';
import type {
  AccountCard,
  ChronologicalRegister,
  GeneralLedger,
  JournalRow,
  TrialBalance,
} from '@kantora/db';
import Decimal from 'decimal.js';
import type { ReportTable } from './export/table';
import { appPool } from './db';

/**
 * Reports for the screens and the Excel/PDF export, so a file can never show different
 * figures from the screen. The SQL is in packages/db/src/reports.ts, where the integration
 * tests reconcile it with the journal; this module binds it to the app pool and turns the
 * results into export tables.
 */
type Tenant = q.ReportTenant;
export type {
  AccountCard,
  ChronologicalRegister,
  GeneralLedger,
  JournalRow,
  LedgerAccount,
  RegisterLine,
  TrialBalance,
} from '@kantora/db';

export const trialBalance = (t: Tenant, periodId: string, from: number, to: number) =>
  q.trialBalance(appPool, t, periodId, from, to);
export const accountCard = (
  t: Tenant,
  accountId: string,
  periodId: string,
  from: number,
  to: number,
) => q.accountCard(appPool, t, accountId, periodId, from, to);
export const generalLedger = (t: Tenant, periodId: string, from: number, to: number) =>
  q.generalLedger(appPool, t, periodId, from, to);
export const chronologicalRegister = (t: Tenant, periodId: string, from: number, to: number) =>
  q.chronologicalRegister(appPool, t, periodId, from, to);
export const journalList = (t: Tenant, periodId: string) => q.journalList(appPool, t, periodId);

export const MONTHS_SHORT = [
  'яну',
  'фев',
  'мар',
  'апр',
  'май',
  'юни',
  'юли',
  'авг',
  'сеп',
  'окт',
  'ное',
  'дек',
];

/** Month range from query parameters, inside 1..12, `from` ≤ `to`. */
export function monthRange(
  sp: { from?: string | undefined; to?: string | undefined },
  fallback: number,
): { from: number; to: number } {
  const clamp = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 12 ? n : d;
  };
  const to = clamp(sp.to, fallback);
  return { from: Math.min(clamp(sp.from, fallback), to), to };
}

export function rangeLabel(from: number, to: number, year: number): string {
  return `${from === to ? MONTHS_SHORT[from - 1] : `${MONTHS_SHORT[from - 1]}–${MONTHS_SHORT[to - 1]}`} ${year}`;
}

const fileDate = (year: number, from: number, to: number) =>
  `${year}-${String(from).padStart(2, '0')}${from === to ? '' : `-${String(to).padStart(2, '0')}`}`;

type RangeMeta = { company: string; year: number; from: number; to: number; currency: string };

export const RECONCILED = 'Равнява се: дебит = кредит във всяка двойка колони.';
export const NOT_RECONCILED =
  'НЕ се равнява. Това не трябва да се случва — съобщете на поддръжката.';

const nz = (v: string) => (new Decimal(v).isZero() ? '' : new Decimal(v).toFixed(2));
const isoToBg = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** A signed balance as (absolute amount, "Дт"/"Кт"/""). */
export function balanceParts(v: string): [string, string] {
  const d = new Decimal(v);
  if (d.isZero()) return ['0.00', ''];
  return [d.abs().toFixed(2), d.isPositive() ? 'Дт' : 'Кт'];
}

// ---------------------------------------------------------------------------
// Оборотна ведомост
// ---------------------------------------------------------------------------
export function trialBalanceTable(tb: TrialBalance, meta: RangeMeta): ReportTable {
  const amount = (header: string, group: string) => ({
    header,
    group,
    kind: 'amount' as const,
    width: 16,
  });
  return {
    fileName: `oborotna-vedomost-${fileDate(meta.year, meta.from, meta.to)}`,
    sheetName: 'Оборотна ведомост',
    title: `Оборотна ведомост — ${meta.company}`,
    subtitle: `${rangeLabel(meta.from, meta.to, meta.year)} · в ${meta.currency} · началните салда са от началото на ${meta.year} г.`,
    columns: [
      { header: 'Сметка', kind: 'text', width: 10 },
      { header: 'Наименование', kind: 'text', width: 34 },
      amount('Дебит', 'Начално салдо'),
      amount('Кредит', 'Начално салдо'),
      amount('Дебит', 'Обороти'),
      amount('Кредит', 'Обороти'),
      amount('Дебит', 'Крайно салдо'),
      amount('Кредит', 'Крайно салдо'),
    ],
    rows: tb.rows.map((r) => [r.code, r.name, ...q.TB_COLS.map((k) => nz(r[k]))]),
    total: ['Общо', '', ...q.TB_COLS.map((k) => tb.totals[k])],
    note: tb.reconciled ? RECONCILED : NOT_RECONCILED,
  };
}

// ---------------------------------------------------------------------------
// Картон на сметка
// ---------------------------------------------------------------------------
export function accountCardTable(card: AccountCard, meta: RangeMeta): ReportTable {
  const code = card.account?.code ?? '';
  const [oAmt, oSide] = balanceParts(card.opening);
  const [cAmt, cSide] = balanceParts(card.closing);
  return {
    fileName: `karton-${code}-${fileDate(meta.year, meta.from, meta.to)}`,
    sheetName: `Картон ${code}`,
    title: `Картон на сметка ${code} ${card.account?.name ?? ''}`,
    subtitle:
      `${meta.company} · ${rangeLabel(meta.from, meta.to, meta.year)} · в ${meta.currency} · начално салдо ${oAmt} ${oSide}`.trim(),
    columns: [
      { header: 'Дата', kind: 'text', width: 11 },
      { header: 'Статия', kind: 'text', width: 8 },
      { header: 'Основание', kind: 'text', width: 40 },
      { header: 'Дебит', kind: 'amount', width: 16 },
      { header: 'Кредит', kind: 'amount', width: 16 },
      { header: 'Салдо', kind: 'amount', width: 16 },
      { header: '', kind: 'text', width: 5 },
    ],
    rows: card.lines.map((l) => {
      const [amt, side] = balanceParts(l.running);
      return [
        isoToBg(l.entry_date),
        String(l.number),
        l.description,
        l.side === 'D' ? l.amount : '',
        l.side === 'C' ? l.amount : '',
        amt,
        side,
      ];
    }),
    total: ['Крайно салдо', '', '', '', '', cAmt, cSide],
  };
}

// ---------------------------------------------------------------------------
// Главна книга
// ---------------------------------------------------------------------------
export const LEDGER_RECONCILED = 'Равнява се: общо дебит = общо кредит.';

export function generalLedgerTable(gl: GeneralLedger, meta: RangeMeta): ReportTable {
  const rows: string[][] = [];
  const strong: number[] = [];
  for (const a of gl.accounts) {
    const [oAmt, oSide] = balanceParts(a.opening);
    const [cAmt, cSide] = balanceParts(a.closing);
    strong.push(rows.length);
    rows.push([`${a.code} ${a.name}`, '', 'Начално салдо', '', '', oAmt, oSide]);
    for (const l of a.lines) {
      rows.push([
        isoToBg(l.entry_date),
        String(l.number),
        l.description,
        l.side === 'D' ? l.amount : '',
        l.side === 'C' ? l.amount : '',
        '',
        '',
      ]);
    }
    strong.push(rows.length);
    rows.push(['', '', `Обороти и крайно салдо ${a.code}`, a.td, a.tc, cAmt, cSide]);
  }
  return {
    fileName: `glavna-kniga-${fileDate(meta.year, meta.from, meta.to)}`,
    sheetName: 'Главна книга',
    title: `Главна книга — ${meta.company}`,
    subtitle: `${rangeLabel(meta.from, meta.to, meta.year)} · в ${meta.currency} · началните салда са от началото на ${meta.year} г.`,
    columns: [
      { header: 'Дата', kind: 'text', width: 11 },
      { header: 'Статия', kind: 'text', width: 8 },
      { header: 'Основание', kind: 'text', width: 40 },
      { header: 'Дебит', kind: 'amount', width: 16 },
      { header: 'Кредит', kind: 'amount', width: 16 },
      { header: 'Салдо', kind: 'amount', width: 16 },
      { header: '', kind: 'text', width: 5 },
    ],
    rows,
    strong,
    total: ['Общо обороти', '', '', gl.totals.td, gl.totals.tc, '', ''],
    note: gl.totals.td === gl.totals.tc ? LEDGER_RECONCILED : NOT_RECONCILED,
  };
}

// ---------------------------------------------------------------------------
// Хронологичен регистър
// ---------------------------------------------------------------------------
export const REGISTER_RECONCILED = 'Равнява се: общо дебит = общо кредит.';

/**
 * Line text, or the entry's. A reversal names the reversed entry; app.reverse_entry writes
 * "Сторно на статия № N" by default, and a custom text gets the mark appended.
 */
export function registerDescription(l: ChronologicalRegister['lines'][number]): string {
  const text = l.line_description || l.entry_description;
  if (l.reverses_number === null || text.includes(`№ ${l.reverses_number}`)) return text;
  return `${text} (сторно на № ${l.reverses_number})`;
}

export function registerTable(reg: ChronologicalRegister, meta: RangeMeta): ReportTable {
  return {
    fileName: `hronologichen-registar-${fileDate(meta.year, meta.from, meta.to)}`,
    sheetName: 'Хронологичен регистър',
    title: `Хронологичен регистър — ${meta.company}`,
    subtitle: `${rangeLabel(meta.from, meta.to, meta.year)} · в ${meta.currency} · ${reg.entries} статии`,
    columns: [
      { header: 'Дата', kind: 'text', width: 11 },
      { header: 'Статия', kind: 'text', width: 8 },
      { header: 'Сметка', kind: 'text', width: 10 },
      { header: 'Наименование', kind: 'text', width: 28 },
      { header: 'Основание', kind: 'text', width: 36 },
      { header: 'Дебит', kind: 'amount', width: 16 },
      { header: 'Кредит', kind: 'amount', width: 16 },
    ],
    rows: reg.lines.map((l) => [
      isoToBg(l.entry_date),
      String(l.number),
      l.code,
      l.account_name,
      registerDescription(l),
      l.side === 'D' ? l.amount : '',
      l.side === 'C' ? l.amount : '',
    ]),
    total: ['Общо', '', '', '', '', reg.totals.d, reg.totals.c],
    note: reg.totals.d === reg.totals.c ? REGISTER_RECONCILED : NOT_RECONCILED,
  };
}

// ---------------------------------------------------------------------------
// Статии за периода
// ---------------------------------------------------------------------------
export const entryState = (r: Pick<JournalRow, 'reverses_entry_id' | 'reversed_by'>) =>
  r.reverses_entry_id ? 'Сторно' : r.reversed_by ? 'Сторниран' : 'Осчетоводен';

export function journalTable(
  rows: JournalRow[],
  meta: { company: string; year: number; month: number; currency: string; label: string },
): ReportTable {
  const total = rows.reduce((s, r) => s.plus(r.total), new Decimal(0)).toFixed(2);
  return {
    fileName: `statii-${fileDate(meta.year, meta.month, meta.month)}`,
    sheetName: 'Статии',
    title: `Статии — ${meta.company}`,
    subtitle: `${meta.label} · в ${meta.currency}`,
    columns: [
      { header: '№', kind: 'text', width: 7 },
      { header: 'Дата', kind: 'text', width: 11 },
      { header: 'Основание', kind: 'text', width: 46 },
      { header: 'Сума', kind: 'amount', width: 15 },
      { header: 'Състояние', kind: 'text', width: 13 },
    ],
    rows: rows.map((r) => [
      String(r.number),
      isoToBg(r.entry_date),
      r.description,
      new Decimal(r.total).toFixed(2),
      entryState(r),
    ]),
    total: ['Общо', '', '', total, ''],
  };
}

// ---------------------------------------------------------------------------
// Аналитична справка и извлечение по контрагент (ADR-0014)
// ---------------------------------------------------------------------------
export type {
  AnalyticBy,
  AnalyticReport,
  AnalyticReportRow,
  CounterpartyStatement,
} from '@kantora/db';
export { ANALYTIC_BY } from '@kantora/db';

export const analyticReport = (
  t: Tenant,
  accountId: string,
  by: q.AnalyticBy,
  periodId: string,
  from: number,
  to: number,
) => q.analyticReport(appPool, t, accountId, by, periodId, from, to);
export const counterpartyStatement = (
  t: Tenant,
  counterpartyId: string,
  periodId: string,
  from: number,
  to: number,
) => q.counterpartyStatement(appPool, t, counterpartyId, periodId, from, to);

export const ANALYTIC_LABEL: Record<q.AnalyticBy, string> = {
  counterparty: 'по контрагенти',
  document: 'по документи',
  cost_object: 'по обекти',
};
export const ANALYTIC_RECONCILED =
  'Равнява се: сборът на редовете е равен на сметката в оборотната ведомост.';

/** What a row of the analytic report is about, in words. */
export function analyticRowLabel(r: q.AnalyticReportRow, by: q.AnalyticBy): string {
  if (by === 'cost_object') {
    return r.cost_object_id ? `${r.cost_object_code} ${r.cost_object_name}` : 'Без обект';
  }
  const cp = r.counterparty_id
    ? `${r.counterparty_name}${r.eik ? ` (${r.eik})` : ''}`
    : 'Без контрагент';
  if (by === 'counterparty') return cp;
  const doc = r.document_number
    ? `№ ${r.document_number}${r.document_date ? ` от ${isoToBg(r.document_date)}` : ''}`
    : 'без документ';
  return `${cp} · ${doc}`;
}

const signedCols = (header: string) => [
  { header, kind: 'amount' as const, width: 16 },
  { header: '', kind: 'text' as const, width: 5 },
];

export function analyticTable(
  rep: q.AnalyticReport,
  by: q.AnalyticBy,
  meta: RangeMeta,
): ReportTable {
  const code = rep.account?.code ?? '';
  const row = (
    label: string,
    s: Pick<q.AnalyticReportRow, 'opening' | 'debit' | 'credit' | 'closing'>,
  ) => [label, ...balanceParts(s.opening), nz(s.debit), nz(s.credit), ...balanceParts(s.closing)];
  return {
    fileName: `analitichna-${code}-${by}-${fileDate(meta.year, meta.from, meta.to)}`,
    sheetName: `Аналитична ${code}`,
    title: `Сметка ${code} ${rep.account?.name ?? ''} ${ANALYTIC_LABEL[by]}`,
    subtitle: `${meta.company} · ${rangeLabel(meta.from, meta.to, meta.year)} · в ${meta.currency}`,
    columns: [
      { header: by === 'cost_object' ? 'Обект' : 'Контрагент / документ', kind: 'text', width: 44 },
      ...signedCols('Начално салдо'),
      { header: 'Дебит', kind: 'amount', width: 16 },
      { header: 'Кредит', kind: 'amount', width: 16 },
      ...signedCols('Крайно салдо'),
    ],
    rows: rep.rows.map((r) => row(analyticRowLabel(r, by), r)),
    total: row('Общо', rep.totals),
    note: rep.reconciled ? ANALYTIC_RECONCILED : NOT_RECONCILED,
  };
}

export function statementTable(st: q.CounterpartyStatement, meta: RangeMeta): ReportTable {
  const name = st.counterparty?.name ?? '';
  return {
    fileName: `izvlechenie-${name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')}-${fileDate(meta.year, meta.from, meta.to)}`,
    sheetName: 'Извлечение',
    title: `Извлечение по контрагент ${name}${st.counterparty?.eik ? `, ЕИК ${st.counterparty.eik}` : ''}`,
    subtitle: `${meta.company} · ${rangeLabel(meta.from, meta.to, meta.year)} · в ${meta.currency}`,
    columns: [
      { header: 'Дата', kind: 'text', width: 11 },
      { header: 'Статия', kind: 'text', width: 8 },
      { header: 'Сметка', kind: 'text', width: 9 },
      { header: 'Документ', kind: 'text', width: 22 },
      { header: 'Основание', kind: 'text', width: 34 },
      { header: 'Дебит', kind: 'amount', width: 15 },
      { header: 'Кредит', kind: 'amount', width: 15 },
    ],
    rows: [
      ...st.accounts.map((a) => {
        const [oa, os] = balanceParts(a.opening);
        const [ca, cs] = balanceParts(a.closing);
        return [
          '',
          '',
          a.code,
          '',
          `${a.name}: начално ${oa} ${os}, крайно ${ca} ${cs}`.replace(/\s+/g, ' ').trim(),
          nz(a.debit),
          nz(a.credit),
        ];
      }),
      ...st.lines.map((l) => [
        isoToBg(l.entry_date),
        String(l.number),
        l.code,
        l.document_number
          ? `${l.document_number}${l.document_date ? ` / ${isoToBg(l.document_date)}` : ''}`
          : '',
        l.description,
        l.side === 'D' ? l.amount : '',
        l.side === 'C' ? l.amount : '',
      ]),
    ],
    strong: st.accounts.map((_, i) => i),
  };
}
