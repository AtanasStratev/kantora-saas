import Decimal from 'decimal.js';
import type { Pool } from 'pg';
import { withTenant } from './tenant';

/**
 * Report queries (phase 2 step 4). They live here, not in the web app, so that the
 * integration tests reconcile THE SAME SQL the screens and the Excel/PDF files use with the
 * journal (PROMPT.md 3.5). All arithmetic is PostgreSQL numeric or decimal.js, never float.
 *
 * Every report covers months [from..to] of the fiscal year of `periodId`; opening balances
 * are the posted entries of the same fiscal year before `from` (years have different ledger
 * currencies, BGN until 2025 and EUR from 2026, and are never mixed). Only posted entries
 * count; drafts are not in the books. Opening lines (`is_opening`, the BGN → EUR
 * conversion, ADR-0016) are always part of the opening balance, never of the turnover.
 */
export type ReportTenant = { userId: string; officeId: string; companyId: string };

const byCode = <T extends { code: string }>(a: T, b: T) =>
  a.code.localeCompare(b.code, 'bg', { numeric: true });

/** Lines of posted entries in the fiscal year of $1 (a period id). */
const POSTED_IN_YEAR = `FROM app.journal_line l
  JOIN app.journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
  JOIN app.period p ON p.id = e.period_id
  WHERE p.fiscal_year_id = (SELECT fiscal_year_id FROM app.period WHERE id = $1)`;

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
export const TB_COLS = ['od', 'oc', 'td', 'tc', 'cd', 'cc'] as const;
export type TrialBalance = {
  rows: TrialBalanceRow[];
  totals: Record<(typeof TB_COLS)[number], string>;
  reconciled: boolean;
};

/** Net balances per side, exactly like domain/journal.ts trialBalance. */
export async function trialBalance(
  pool: Pool,
  tenant: ReportTenant,
  periodId: string,
  from: number,
  to: number,
): Promise<TrialBalance> {
  const rows = await withTenant(pool, tenant, async (c) =>
    (
      await c.query<TrialBalanceRow>(
        `WITH sums AS (
           SELECT l.account_id,
                  coalesce(sum(l.amount) FILTER (WHERE l.side = 'D' AND (p.month < $2 OR l.is_opening)), 0) AS od,
                  coalesce(sum(l.amount) FILTER (WHERE l.side = 'C' AND (p.month < $2 OR l.is_opening)), 0) AS oc,
                  coalesce(sum(l.amount) FILTER (WHERE l.side = 'D' AND p.month >= $2 AND NOT l.is_opening), 0) AS td,
                  coalesce(sum(l.amount) FILTER (WHERE l.side = 'C' AND p.month >= $2 AND NOT l.is_opening), 0) AS tc
           ${POSTED_IN_YEAR} AND p.month <= $3
           GROUP BY l.account_id)
         SELECT a.id AS account_id, a.code, a.name,
                greatest(od - oc, 0)::text AS od, greatest(oc - od, 0)::text AS oc,
                td::text AS td, tc::text AS tc,
                greatest(od + td - oc - tc, 0)::text AS cd, greatest(oc + tc - od - td, 0)::text AS cc
         FROM sums JOIN app.account a ON a.id = sums.account_id`,
        [periodId, from, to],
      )
    ).rows // Only accounts with any amount, as in domain/journal.ts.
      .filter((r) => TB_COLS.some((k) => !new Decimal(r[k]).isZero()))
      .sort(byCode),
  );
  const totals = Object.fromEntries(
    TB_COLS.map((k) => [k, rows.reduce((s, r) => s.plus(r[k]), new Decimal(0)).toFixed(2)]),
  ) as TrialBalance['totals'];
  const reconciled = totals.od === totals.oc && totals.td === totals.tc && totals.cd === totals.cc;
  return { rows, totals, reconciled };
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
  pool: Pool,
  tenant: ReportTenant,
  accountId: string,
  periodId: string,
  from: number,
  to: number,
): Promise<AccountCard> {
  return withTenant(pool, tenant, async (c) => {
    const acc = await c.query<{ code: string; name: string }>(
      'SELECT code, name FROM app.account WHERE id = $1',
      [accountId],
    );
    const opening = await c.query<{ v: string }>(
      `SELECT coalesce(sum(CASE l.side WHEN 'D' THEN l.amount ELSE -l.amount END), 0)::text AS v
       ${POSTED_IN_YEAR} AND l.account_id = $2 AND (p.month < $3 OR l.is_opening)`,
      [periodId, accountId, from],
    );
    const open = opening.rows[0]?.v ?? '0';
    const lines = await c.query<AccountCardLine>(
      `SELECT e.id AS entry_id, e.number, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date,
              coalesce(nullif(l.description, ''), e.description) AS description, l.side, l.amount::text,
              ($5::numeric + sum(CASE l.side WHEN 'D' THEN l.amount ELSE -l.amount END)
                 OVER (ORDER BY e.entry_date, e.number, l.line_no))::text AS running
       ${POSTED_IN_YEAR} AND l.account_id = $2 AND p.month BETWEEN $3 AND $4 AND NOT l.is_opening
       ORDER BY e.entry_date, e.number, l.line_no`,
      [periodId, accountId, from, to, open],
    );
    return {
      account: acc.rows[0],
      opening: open,
      closing: lines.rows.at(-1)?.running ?? open,
      lines: lines.rows,
    };
  });
}

// ---------------------------------------------------------------------------
// Главна книга: систематичен регистър (ЗСч, чл. 16, ал. 1, т. 3). Every account with
// its opening balance, every movement of the range, turnover and closing balance.
// ---------------------------------------------------------------------------
export type LedgerLine = {
  entry_id: string;
  number: number;
  entry_date: string;
  description: string;
  side: 'D' | 'C';
  amount: string;
};
export type LedgerAccount = {
  account_id: string;
  code: string;
  name: string;
  /** Signed: positive = debit balance. */
  opening: string;
  td: string;
  tc: string;
  /** Signed: opening + td − tc. */
  closing: string;
  lines: LedgerLine[];
};
export type GeneralLedger = {
  accounts: LedgerAccount[];
  totals: { td: string; tc: string };
};

export async function generalLedger(
  pool: Pool,
  tenant: ReportTenant,
  periodId: string,
  from: number,
  to: number,
): Promise<GeneralLedger> {
  const { opening, lines } = await withTenant(pool, tenant, async (c) => {
    const opening = await c.query<{ account_id: string; code: string; name: string; v: string }>(
      `SELECT a.id AS account_id, a.code, a.name,
              coalesce(sum(CASE l.side WHEN 'D' THEN l.amount ELSE -l.amount END)
                       FILTER (WHERE p.month < $2 OR l.is_opening), 0)::text AS v
       FROM app.journal_line l
       JOIN app.journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
       JOIN app.period p ON p.id = e.period_id
       JOIN app.account a ON a.id = l.account_id
       WHERE p.fiscal_year_id = (SELECT fiscal_year_id FROM app.period WHERE id = $1)
         AND p.month <= $3
       GROUP BY a.id, a.code, a.name`,
      [periodId, from, to],
    );
    const lines = await c.query<LedgerLine & { account_id: string }>(
      `SELECT l.account_id, e.id AS entry_id, e.number, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date,
              coalesce(nullif(l.description, ''), e.description) AS description, l.side, l.amount::text
       ${POSTED_IN_YEAR} AND p.month BETWEEN $2 AND $3 AND NOT l.is_opening
       ORDER BY e.entry_date, e.number, l.line_no`,
      [periodId, from, to],
    );
    return { opening: opening.rows, lines: lines.rows };
  });

  const byAccount = new Map<string, LedgerLine[]>();
  for (const { account_id, ...l } of lines) {
    const list = byAccount.get(account_id) ?? [];
    list.push(l);
    byAccount.set(account_id, list);
  }
  const accounts = opening
    .map((a): LedgerAccount => {
      const own = byAccount.get(a.account_id) ?? [];
      const sum = (side: 'D' | 'C') =>
        own.filter((l) => l.side === side).reduce((s, l) => s.plus(l.amount), new Decimal(0));
      const td = sum('D');
      const tc = sum('C');
      return {
        account_id: a.account_id,
        code: a.code,
        name: a.name,
        opening: new Decimal(a.v).toFixed(2),
        td: td.toFixed(2),
        tc: tc.toFixed(2),
        closing: new Decimal(a.v).plus(td).minus(tc).toFixed(2),
        lines: own,
      };
    })
    // The same accounts as the trial balance: any opening balance or any movement.
    .filter((a) => a.lines.length > 0 || !new Decimal(a.opening).isZero())
    .sort(byCode);
  const total = (k: 'td' | 'tc') =>
    accounts.reduce((s, a) => s.plus(a[k]), new Decimal(0)).toFixed(2);
  return { accounts, totals: { td: total('td'), tc: total('tc') } };
}

// ---------------------------------------------------------------------------
// Хронологичен регистър (ЗСч, чл. 3, ал. 2; чл. 4, ал. 4): every line of every posted
// entry of the range, in date order.
// ---------------------------------------------------------------------------
export type RegisterLine = {
  entry_id: string;
  number: number;
  line_no: number;
  entry_date: string;
  entry_description: string;
  line_description: string;
  code: string;
  account_name: string;
  side: 'D' | 'C';
  amount: string;
  reverses_number: number | null;
  /** An opening balance line (BGN → EUR conversion), not an operation of the period. */
  is_opening: boolean;
};
export type ChronologicalRegister = {
  lines: RegisterLine[];
  entries: number;
  totals: { d: string; c: string };
};

export async function chronologicalRegister(
  pool: Pool,
  tenant: ReportTenant,
  periodId: string,
  from: number,
  to: number,
): Promise<ChronologicalRegister> {
  const lines = await withTenant(
    pool,
    tenant,
    async (c) =>
      (
        await c.query<RegisterLine>(
          `SELECT e.id AS entry_id, e.number, l.line_no, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date,
                  e.description AS entry_description, coalesce(l.description, '') AS line_description,
                  a.code, a.name AS account_name, l.side, l.amount::text, r.number AS reverses_number,
                  l.is_opening
           FROM app.journal_line l
           JOIN app.journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
           JOIN app.period p ON p.id = e.period_id
           JOIN app.account a ON a.id = l.account_id
           LEFT JOIN app.journal_entry r ON r.id = e.reverses_entry_id
           WHERE p.fiscal_year_id = (SELECT fiscal_year_id FROM app.period WHERE id = $1)
             AND p.month BETWEEN $2 AND $3
           ORDER BY e.entry_date, e.number, l.line_no`,
          [periodId, from, to],
        )
      ).rows,
  );
  const sum = (side: 'D' | 'C') =>
    lines
      .filter((l) => l.side === side)
      .reduce((s, l) => s.plus(l.amount), new Decimal(0))
      .toFixed(2);
  return {
    lines,
    entries: new Set(lines.map((l) => l.entry_id)).size,
    totals: { d: sum('D'), c: sum('C') },
  };
}

// ---------------------------------------------------------------------------
// Статии за периода
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

export async function journalList(
  pool: Pool,
  tenant: ReportTenant,
  periodId: string,
): Promise<JournalRow[]> {
  return withTenant(
    pool,
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
