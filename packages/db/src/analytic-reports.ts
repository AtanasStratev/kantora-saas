import Decimal from 'decimal.js';
import type { Pool } from 'pg';
import type { ReportTenant } from './reports';
import { withTenant } from './tenant';

/**
 * Analytic reports (ADR-0014). Same conventions as reports.ts: one fiscal year, months
 * [from..to], posted entries only, numeric/decimal.js only. Tested against the trial
 * balance in reports.int.test.ts.
 */

type Sums = { opening: string; debit: string; credit: string; closing: string };
const ZERO = '0.00';
const fix = (s: { opening: string; debit: string; credit: string }): Sums => {
  const o = new Decimal(s.opening);
  return {
    opening: o.toFixed(2),
    debit: new Decimal(s.debit).toFixed(2),
    credit: new Decimal(s.credit).toFixed(2),
    closing: o.plus(s.debit).minus(s.credit).toFixed(2),
  };
};
const nonZero = (s: Sums) => [s.opening, s.debit, s.credit, s.closing].some((v) => v !== ZERO);

// Signed opening before month $3, turnovers in months $3.., for lines up to month $4.
const SUMS = `coalesce(sum(CASE l.side WHEN 'D' THEN l.amount ELSE -l.amount END) FILTER (WHERE p.month < $3), 0)::text AS opening,
  coalesce(sum(l.amount) FILTER (WHERE l.side = 'D' AND p.month >= $3), 0)::text AS debit,
  coalesce(sum(l.amount) FILTER (WHERE l.side = 'C' AND p.month >= $3), 0)::text AS credit`;
const LINES_IN_YEAR = `FROM app.journal_line l
  JOIN app.journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
  JOIN app.period p ON p.id = e.period_id
  WHERE p.fiscal_year_id = (SELECT fiscal_year_id FROM app.period WHERE id = $1) AND p.month <= $4`;

// ---------------------------------------------------------------------------
// Аналитична справка: ONE account per counterparty, per document of a counterparty, or
// per cost object. Lines without that analytic form their own row, so the rows always add
// up to the account; the account as a whole is read in the same transaction.
// ---------------------------------------------------------------------------
export type AnalyticBy = 'counterparty' | 'document' | 'cost_object';
export const ANALYTIC_BY: readonly AnalyticBy[] = ['counterparty', 'document', 'cost_object'];

export type AnalyticReportRow = Sums & {
  counterparty_id: string | null;
  counterparty_name: string | null;
  eik: string | null;
  document_number: string | null;
  document_date: string | null;
  cost_object_id: string | null;
  cost_object_code: string | null;
  cost_object_name: string | null;
};
export type AnalyticAccount = {
  code: string;
  name: string;
  needs_counterparty: boolean;
  needs_document: boolean;
  needs_cost_object: boolean;
};
export type AnalyticReport = {
  account: AnalyticAccount | undefined;
  rows: AnalyticReportRow[];
  totals: Sums;
  /** The account as a whole (same transaction), for the on-screen reconciliation. */
  ledger: Sums;
  reconciled: boolean;
};

// Fixed SQL fragments per grouping; never built from user input.
const GROUPING: Record<AnalyticBy, { select: string; group: string }> = {
  counterparty: {
    select: `l.counterparty_id, NULL::text AS document_number, NULL::text AS document_date,
             NULL::uuid AS cost_object_id`,
    group: 'l.counterparty_id',
  },
  document: {
    // A document is its counterparty + number; the date is shown (the earliest given),
    // not part of the key: a payment line usually carries the number only.
    select: `l.counterparty_id, l.document_number,
             to_char(min(l.document_date), 'YYYY-MM-DD') AS document_date, NULL::uuid AS cost_object_id`,
    group: 'l.counterparty_id, l.document_number',
  },
  cost_object: {
    select: `NULL::uuid AS counterparty_id, NULL::text AS document_number,
             NULL::text AS document_date, l.cost_object_id`,
    group: 'l.cost_object_id',
  },
};

export async function analyticReport(
  pool: Pool,
  tenant: ReportTenant,
  accountId: string,
  by: AnalyticBy,
  periodId: string,
  from: number,
  to: number,
): Promise<AnalyticReport> {
  const g = GROUPING[by];
  return withTenant(pool, tenant, async (c) => {
    const acc = await c.query<AnalyticAccount>(
      `SELECT code, name, needs_counterparty, needs_document, needs_cost_object
       FROM app.account WHERE id = $1`,
      [accountId],
    );
    const raw = await c.query<{
      counterparty_id: string | null;
      document_number: string | null;
      document_date: string | null;
      cost_object_id: string | null;
      opening: string;
      debit: string;
      credit: string;
    }>(
      `SELECT ${g.select}, ${SUMS}
       ${LINES_IN_YEAR} AND l.account_id = $2
       GROUP BY ${g.group}`,
      [periodId, accountId, from, to],
    );
    const whole = await c.query<{ opening: string; debit: string; credit: string }>(
      `SELECT ${SUMS} ${LINES_IN_YEAR} AND l.account_id = $2`,
      [periodId, accountId, from, to],
    );
    const cpIds = [...new Set(raw.rows.flatMap((r) => r.counterparty_id ?? []))];
    const objIds = [...new Set(raw.rows.flatMap((r) => r.cost_object_id ?? []))];
    const cps = new Map(
      (
        await c.query<{ id: string; name: string; eik: string | null }>(
          'SELECT id, name, eik FROM app.counterparty WHERE id = ANY($1)',
          [cpIds],
        )
      ).rows.map((r) => [r.id, r]),
    );
    const objs = new Map(
      (
        await c.query<{ id: string; code: string; name: string }>(
          'SELECT id, code, name FROM app.cost_object WHERE id = ANY($1)',
          [objIds],
        )
      ).rows.map((r) => [r.id, r]),
    );

    const rows = raw.rows
      .map((r): AnalyticReportRow => {
        const cp = r.counterparty_id ? cps.get(r.counterparty_id) : undefined;
        const obj = r.cost_object_id ? objs.get(r.cost_object_id) : undefined;
        return {
          counterparty_id: r.counterparty_id,
          counterparty_name: cp?.name ?? null,
          eik: cp?.eik ?? null,
          document_number: r.document_number,
          document_date: r.document_date,
          cost_object_id: r.cost_object_id,
          cost_object_code: obj?.code ?? null,
          cost_object_name: obj?.name ?? null,
          ...fix(r),
        };
      })
      .filter(nonZero)
      .sort(compareRows(by));
    const total = (k: keyof Sums) => rows.reduce((s, r) => s.plus(r[k]), new Decimal(0)).toFixed(2);
    const totals: Sums = {
      opening: total('opening'),
      debit: total('debit'),
      credit: total('credit'),
      closing: total('closing'),
    };
    const ledger = fix(whole.rows[0] ?? { opening: '0', debit: '0', credit: '0' });
    const reconciled = (Object.keys(totals) as (keyof Sums)[]).every(
      (k) => totals[k] === ledger[k],
    );
    return { account: acc.rows[0], rows, totals, ledger, reconciled };
  });
}

/** Rows without the analytic last; then by name / code, document date and number. */
function compareRows(by: AnalyticBy) {
  const missing = (r: AnalyticReportRow) =>
    by === 'cost_object'
      ? r.cost_object_id === null
      : by === 'document'
        ? r.counterparty_id === null && r.document_number === null
        : r.counterparty_id === null;
  return (a: AnalyticReportRow, b: AnalyticReportRow) =>
    Number(missing(a)) - Number(missing(b)) ||
    (a.counterparty_name ?? '').localeCompare(b.counterparty_name ?? '', 'bg') ||
    (a.cost_object_code ?? '').localeCompare(b.cost_object_code ?? '', 'bg', { numeric: true }) ||
    (a.document_date ?? '').localeCompare(b.document_date ?? '') ||
    (a.document_number ?? '').localeCompare(b.document_number ?? '', 'bg', { numeric: true });
}

// ---------------------------------------------------------------------------
// Извлечение по контрагент (PROMPT.md 6.2): one counterparty on every account, with the
// lines of the range. Per account these are the numbers of the analytic report.
// ---------------------------------------------------------------------------
export type StatementAccount = Sums & { account_id: string; code: string; name: string };
export type StatementLine = {
  entry_id: string;
  number: number;
  entry_date: string;
  code: string;
  document_number: string | null;
  document_date: string | null;
  description: string;
  side: 'D' | 'C';
  amount: string;
};
export type CounterpartyStatement = {
  counterparty: { name: string; eik: string | null; vat_number: string | null } | undefined;
  accounts: StatementAccount[];
  lines: StatementLine[];
};

export async function counterpartyStatement(
  pool: Pool,
  tenant: ReportTenant,
  counterpartyId: string,
  periodId: string,
  from: number,
  to: number,
): Promise<CounterpartyStatement> {
  return withTenant(pool, tenant, async (c) => {
    const cp = await c.query<NonNullable<CounterpartyStatement['counterparty']>>(
      'SELECT name, eik, vat_number FROM app.counterparty WHERE id = $1',
      [counterpartyId],
    );
    const accs = await c.query<{
      account_id: string;
      code: string;
      name: string;
      opening: string;
      debit: string;
      credit: string;
    }>(
      `SELECT a.id AS account_id, a.code, a.name, ${SUMS}
       FROM app.journal_line l
       JOIN app.journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
       JOIN app.period p ON p.id = e.period_id
       JOIN app.account a ON a.id = l.account_id
       WHERE p.fiscal_year_id = (SELECT fiscal_year_id FROM app.period WHERE id = $1)
         AND p.month <= $4 AND l.counterparty_id = $2
       GROUP BY a.id, a.code, a.name`,
      [periodId, counterpartyId, from, to],
    );
    const lines = await c.query<StatementLine>(
      `SELECT e.id AS entry_id, e.number, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, a.code,
              l.document_number, to_char(l.document_date, 'YYYY-MM-DD') AS document_date,
              coalesce(nullif(l.description, ''), e.description) AS description, l.side,
              l.amount::text
       FROM app.journal_line l
       JOIN app.journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
       JOIN app.period p ON p.id = e.period_id
       JOIN app.account a ON a.id = l.account_id
       WHERE p.fiscal_year_id = (SELECT fiscal_year_id FROM app.period WHERE id = $1)
         AND p.month BETWEEN $3 AND $4 AND l.counterparty_id = $2
       ORDER BY e.entry_date, e.number, l.line_no`,
      [periodId, counterpartyId, from, to],
    );
    const accounts = accs.rows
      .map(({ account_id, code, name, ...s }) => ({ account_id, code, name, ...fix(s) }))
      .filter(nonZero)
      .sort((a, b) => a.code.localeCompare(b.code, 'bg', { numeric: true }));
    return { counterparty: cp.rows[0], accounts, lines: lines.rows };
  });
}
