import 'server-only';
import { withTenant } from '@kantora/db';
import Decimal from 'decimal.js';
import type { ReportTable } from './export/table';
import { appPool } from './db';

/**
 * Report queries shared by the screens and the Excel/PDF export, so a file can never show
 * different figures from the screen. All arithmetic is PostgreSQL numeric or decimal.js.
 */
type Tenant = { userId: string; officeId: string; companyId: string };

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

// ---------------------------------------------------------------------------
// Оборотна ведомост
// ---------------------------------------------------------------------------
export type TrialBalanceRow = {
  account_id: string;
  code: string;
  name: string;
  od: string;
  oc: string;
  td: string;
  tc: string;
  cd: string;
  cc: string;
};
const TB_COLS = ['od', 'oc', 'td', 'tc', 'cd', 'cc'] as const;
export type TrialBalance = {
  rows: TrialBalanceRow[];
  totals: Record<(typeof TB_COLS)[number], string>;
  reconciled: boolean;
};

/**
 * Months [from..to] of the fiscal year of `periodId`. Opening = posted entries of the same
 * fiscal year before `from` (years have different ledger currencies and are never mixed).
 * Net balances per side, exactly like domain/journal.ts trialBalance.
 */
export async function trialBalance(
  tenant: Tenant,
  periodId: string,
  from: number,
  to: number,
): Promise<TrialBalance> {
  const rows = await withTenant(appPool, tenant, async (c) =>
    (
      await c.query<TrialBalanceRow>(
        `WITH fy AS (SELECT p.fiscal_year_id AS id FROM app.period p WHERE p.id = $1),
              sums AS (
                SELECT l.account_id,
                       coalesce(sum(l.amount) FILTER (WHERE l.side = 'D' AND p.month < $2), 0) AS od,
                       coalesce(sum(l.amount) FILTER (WHERE l.side = 'C' AND p.month < $2), 0) AS oc,
                       coalesce(sum(l.amount) FILTER (WHERE l.side = 'D' AND p.month >= $2), 0) AS td,
                       coalesce(sum(l.amount) FILTER (WHERE l.side = 'C' AND p.month >= $2), 0) AS tc
                FROM app.journal_line l
                JOIN app.journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
                JOIN app.period p ON p.id = e.period_id
                WHERE p.fiscal_year_id = (SELECT id FROM fy) AND p.month <= $3
                GROUP BY l.account_id)
         SELECT a.id AS account_id, a.code, a.name,
                greatest(od - oc, 0)::text AS od, greatest(oc - od, 0)::text AS oc,
                td::text AS td, tc::text AS tc,
                greatest(od + td - oc - tc, 0)::text AS cd, greatest(oc + tc - od - td, 0)::text AS cc
         FROM sums JOIN app.account a ON a.id = sums.account_id`,
        [periodId, from, to],
      )
    ).rows.sort((x, y) => x.code.localeCompare(y.code, 'bg', { numeric: true })),
  );
  const totals = Object.fromEntries(
    TB_COLS.map((k) => [k, rows.reduce((s, r) => s.plus(r[k]), new Decimal(0)).toFixed(2)]),
  ) as TrialBalance['totals'];
  const reconciled = totals.od === totals.oc && totals.td === totals.tc && totals.cd === totals.cc;
  return { rows, totals, reconciled };
}

export const RECONCILED = 'Равнява се: дебит = кредит във всяка двойка колони.';
export const NOT_RECONCILED =
  'НЕ се равнява. Това не трябва да се случва — съобщете на поддръжката.';

const nz = (v: string) => (new Decimal(v).isZero() ? '' : new Decimal(v).toFixed(2));

export function trialBalanceTable(
  tb: TrialBalance,
  meta: { company: string; year: number; from: number; to: number; currency: string },
): ReportTable {
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
    rows: tb.rows.map((r) => [r.code, r.name, ...TB_COLS.map((k) => nz(r[k]))]),
    total: ['Общо', '', ...TB_COLS.map((k) => tb.totals[k])],
    note: tb.reconciled ? RECONCILED : NOT_RECONCILED,
  };
}

// ---------------------------------------------------------------------------
// Картон на сметка
// ---------------------------------------------------------------------------
export type AccountCardLine = {
  entry_id: string;
  number: number;
  entry_date: string;
  description: string;
  side: 'D' | 'C';
  amount: string;
  running: string;
};
export type AccountCard = {
  account: { code: string; name: string } | undefined;
  opening: string;
  closing: string;
  lines: AccountCardLine[];
};

export async function accountCard(
  tenant: Tenant,
  accountId: string,
  periodId: string,
  from: number,
  to: number,
): Promise<AccountCard> {
  return withTenant(appPool, tenant, async (c) => {
    const acc = await c.query<{ code: string; name: string }>(
      'SELECT code, name FROM app.account WHERE id = $1',
      [accountId],
    );
    const base = `FROM app.journal_line l
                  JOIN app.journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
                  JOIN app.period p ON p.id = e.period_id
                  WHERE l.account_id = $1
                    AND p.fiscal_year_id = (SELECT fiscal_year_id FROM app.period WHERE id = $2)`;
    const opening = await c.query<{ v: string }>(
      `SELECT coalesce(sum(CASE l.side WHEN 'D' THEN l.amount ELSE -l.amount END), 0)::text AS v
       ${base} AND p.month < $3`,
      [accountId, periodId, from],
    );
    const open = opening.rows[0]?.v ?? '0';
    const lines = await c.query<AccountCardLine>(
      `SELECT e.id AS entry_id, e.number, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date,
              coalesce(nullif(l.description, ''), e.description) AS description, l.side, l.amount::text,
              ($5::numeric + sum(CASE l.side WHEN 'D' THEN l.amount ELSE -l.amount END)
                 OVER (ORDER BY e.entry_date, e.number, l.line_no))::text AS running
       ${base} AND p.month BETWEEN $3 AND $4
       ORDER BY e.entry_date, e.number, l.line_no`,
      [accountId, periodId, from, to, open],
    );
    return {
      account: acc.rows[0],
      opening: open,
      closing: lines.rows.at(-1)?.running ?? open,
      lines: lines.rows,
    };
  });
}

/** A signed balance as (absolute amount, "Дт"/"Кт"/""). */
export function balanceParts(v: string): [string, string] {
  const d = new Decimal(v);
  if (d.isZero()) return ['0.00', ''];
  return [d.abs().toFixed(2), d.isPositive() ? 'Дт' : 'Кт'];
}

const isoToBg = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export function accountCardTable(
  card: AccountCard,
  meta: { company: string; year: number; from: number; to: number; currency: string },
): ReportTable {
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
// Статии за периода (хронологичен списък)
// ---------------------------------------------------------------------------
export type JournalRow = {
  id: string;
  number: number;
  entry_date: string;
  description: string;
  total: string;
  reverses_entry_id: string | null;
  reversed_by: string | null;
};

export async function journalList(tenant: Tenant, periodId: string): Promise<JournalRow[]> {
  return withTenant(
    appPool,
    tenant,
    async (c) =>
      (
        await c.query<JournalRow>(
          `SELECT e.id, e.number, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.description,
                (SELECT sum(amount) FROM app.journal_line l WHERE l.entry_id = e.id AND l.side = 'D')::text AS total,
                e.reverses_entry_id, r.id AS reversed_by
         FROM app.journal_entry e
         LEFT JOIN app.journal_entry r ON r.reverses_entry_id = e.id
         WHERE e.period_id = $1 AND e.status = 'posted'
         ORDER BY e.number`,
          [periodId],
        )
      ).rows,
  );
}

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
