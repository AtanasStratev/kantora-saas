import { euroConversion, type EuroConversion, type EuroConversionClass } from '@kantora/domain';
import Decimal from 'decimal.js';
import type { Pool, PoolClient } from 'pg';
import type { ReportTenant } from './reports';
import { withTenant } from './tenant';

/**
 * BGN → EUR conversion of the closing balances (ADR-0016, ЗВЕРБ чл. 48). The BGN
 * positions are read and the EUR opening entry is posted in ONE transaction.
 */
export type ConversionKey = {
  accountId: string;
  counterpartyId: string | null;
  documentNumber: string | null;
  documentDate: string | null;
  costObjectId: string | null;
  currency: string | null;
};

export type ConversionPosition = ConversionKey & {
  accountCode: string;
  accountName: string;
  cls: EuroConversionClass;
  isCurrency: boolean;
  /** Signed, in BGN. */
  bgn: string;
  /** Signed, in the currency (currency positions). */
  currencyBalance: string;
};

type Year = { id: string; year: number; startDate: string };

export type ConversionState = {
  from: Year;
  to: Year & { januaryPeriodId: string; januaryLocked: boolean };
  positions: ConversionPosition[];
  conversion: EuroConversion<ConversionKey> | null;
  /** Why the conversion cannot run as things are (blocking). */
  blockers: string[];
  /** Draft entries left in the BGN year (not in the books, not converted). */
  drafts: number;
  /** The run in force, if any, and whether the BGN year changed since. */
  run: { entryId: string; number: number; stale: boolean } | null;
};

export type ConversionUnavailable = {
  error: string;
  /** The BGN year that can be added (app.add_fiscal_year) to make the conversion possible. */
  missingBgnYear?: number;
};

const sourceOf = (ps: readonly ConversionPosition[]) =>
  ps
    .map((p) => [
      p.accountId,
      p.counterpartyId,
      p.documentNumber,
      p.costObjectId,
      p.currency,
      new Decimal(p.bgn).toFixed(2),
      new Decimal(p.currencyBalance).toFixed(2),
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

async function readState(c: PoolClient): Promise<ConversionState | ConversionUnavailable> {
  const years = await c.query<{
    id: string;
    year: number;
    start_date: string;
    ledger_currency: string;
  }>(
    `SELECT id, year, to_char(start_date, 'YYYY-MM-DD') AS start_date, ledger_currency
     FROM app.fiscal_year ORDER BY year`,
  );
  const to = years.rows.find((y) => y.ledger_currency === 'EUR');
  const from = years.rows.find((y) => to && y.year === to.year - 1 && y.ledger_currency === 'BGN');
  if (!to) return { error: 'Фирмата няма година в евро.' };
  if (!from) {
    return {
      error: `Фирмата няма ${to.year - 1} г. в лева: няма какво да се превалутира.`,
      missingBgnYear: to.year - 1,
    };
  }
  const jan = await c.query<{ id: string; locked: boolean }>(
    'SELECT id, locked_at IS NOT NULL AS locked FROM app.period WHERE fiscal_year_id = $1 AND month = 1',
    [to.id],
  );
  const january = jan.rows[0];
  if (!january) return { error: 'Годината в евро няма януари.' };

  const rows = await c.query<{
    account_id: string;
    code: string;
    name: string;
    cls: EuroConversionClass;
    is_currency: boolean;
    counterparty_id: string | null;
    document_number: string | null;
    document_date: string | null;
    cost_object_id: string | null;
    currency: string | null;
    bgn: string;
    cur: string;
  }>(
    `SELECT a.id AS account_id, a.code, a.name, a.euro_conversion AS cls, a.is_currency,
            l.counterparty_id, l.document_number, to_char(min(l.document_date), 'YYYY-MM-DD') AS document_date,
            l.cost_object_id, l.doc_currency AS currency,
            sum(CASE l.side WHEN 'D' THEN l.amount ELSE -l.amount END)::text AS bgn,
            coalesce(sum(CASE l.side WHEN 'D' THEN l.doc_amount ELSE -l.doc_amount END), 0)::text AS cur
     FROM app.journal_line l
     JOIN app.journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
     JOIN app.period p ON p.id = e.period_id AND p.fiscal_year_id = $1
     JOIN app.account a ON a.id = l.account_id
     GROUP BY a.id, a.code, a.name, a.euro_conversion, a.is_currency, l.counterparty_id,
              l.document_number, l.cost_object_id, l.doc_currency`,
    [from.id],
  );
  const positions: ConversionPosition[] = rows.rows
    .filter((r) => !new Decimal(r.bgn).isZero() || !new Decimal(r.cur).isZero())
    .map((r) => ({
      accountId: r.account_id,
      accountCode: r.code,
      accountName: r.name,
      cls: r.cls,
      isCurrency: r.is_currency,
      counterpartyId: r.counterparty_id,
      documentNumber: r.document_number,
      documentDate: r.document_date,
      costObjectId: r.cost_object_id,
      currency: r.currency,
      bgn: r.bgn,
      currencyBalance: r.cur,
    }))
    .sort(
      (a, b) =>
        a.accountCode.localeCompare(b.accountCode, 'bg', { numeric: true }) ||
        (a.documentNumber ?? '').localeCompare(b.documentNumber ?? ''),
    );

  const blockers: string[] = [];
  const euroOnCurrency = [
    ...new Set(
      positions.filter((p) => p.isCurrency && p.currency === 'EUR').map((p) => p.accountCode),
    ),
  ];
  if (euroOnCurrency.length) {
    blockers.push(
      `Сметки ${euroOnCurrency.join(', ')} са валутни, но водят евро. От ${to.year} г. еврото е отчетната валута: махнете отметката „валутна“ в сметкоплана.`,
    );
  }
  const noCurrency = [
    ...new Set(positions.filter((p) => p.isCurrency && !p.currency).map((p) => p.accountCode)),
  ];
  if (noCurrency.length) {
    blockers.push(
      `Сметки ${noCurrency.join(', ')} са валутни, но имат редове без валута през ${from.year} г. Махнете отметката „валутна“ или сторнирайте и въведете редовете с валута.`,
    );
  }
  if (january.locked) blockers.push(`Януари ${to.year} е заключен.`);

  const drafts = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.journal_entry e JOIN app.period p ON p.id = e.period_id
     WHERE p.fiscal_year_id = $1 AND e.status = 'draft'`,
    [from.id],
  );

  const run = await c.query<{ entry_id: string; number: number; source: unknown }>(
    `SELECT r.entry_id, e.number, r.source FROM app.euro_conversion_run r
     JOIN app.journal_entry e ON e.id = r.entry_id
     WHERE r.to_year_id = $1
       AND NOT EXISTS (SELECT 1 FROM app.journal_entry x WHERE x.reverses_entry_id = r.entry_id)`,
    [to.id],
  );
  const active = run.rows[0];

  return {
    from: { id: from.id, year: from.year, startDate: from.start_date },
    to: {
      id: to.id,
      year: to.year,
      startDate: to.start_date,
      januaryPeriodId: january.id,
      januaryLocked: january.locked,
    },
    positions,
    conversion: positions.length
      ? euroConversion(
          positions.map((p) => ({
            key: {
              accountId: p.accountId,
              counterpartyId: p.counterpartyId,
              documentNumber: p.documentNumber,
              documentDate: p.documentDate,
              costObjectId: p.costObjectId,
              currency: p.currency,
            },
            accountCode: p.accountCode,
            cls: p.cls,
            bgn: p.bgn,
          })),
        )
      : null,
    blockers,
    drafts: drafts.rows[0]?.n ?? 0,
    run: active
      ? {
          entryId: active.entry_id,
          number: active.number,
          stale: JSON.stringify(active.source) !== JSON.stringify(sourceOf(positions)),
        }
      : null,
  };
}

export async function euroConversionState(
  pool: Pool,
  tenant: ReportTenant,
): Promise<ConversionState | ConversionUnavailable> {
  return withTenant(pool, tenant, readState);
}

export type ConversionRunResult =
  { ok: true; entryId: string; number: number; lines: number } | { ok: false; error: string };

/**
 * Posts the EUR opening entry: one opening line per converted position (with its
 * analytics; currency positions keep their currency amount), then the rounding: the
 * equity part on `equityAccountId`, the rest on `gainAccountId` (credit) or
 * `lossAccountId` (debit). All lines are opening lines, so the opening balances of the EUR
 * year balance (Dt = Кт) in every report; the differences are in the year's accounts.
 */
export async function runEuroConversion(
  pool: Pool,
  tenant: ReportTenant,
  input: { gainAccountId: string; lossAccountId: string; equityAccountId: string },
): Promise<ConversionRunResult> {
  return withTenant(pool, tenant, async (c) => {
    const st = await readState(c);
    if ('error' in st) return { ok: false, error: st.error };
    if (st.run) {
      return {
        ok: false,
        error: `Превалутирането вече е направено (статия № ${st.run.number}). За ново първо я сторнирайте.`,
      };
    }
    if (st.blockers.length) return { ok: false, error: st.blockers.join(' ') };
    if (!st.conversion)
      return { ok: false, error: `${st.from.year} г. няма салда за превалутиране.` };
    const conv = st.conversion;

    const e = await c.query<{ id: string }>(
      `INSERT INTO app.journal_entry (office_id, company_id, period_id, entry_date, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        tenant.officeId,
        tenant.companyId,
        st.to.januaryPeriodId,
        st.to.startDate,
        `Превалутиране на салдата към 31.12.${st.from.year} от лева в евро (ЗВЕРБ, чл. 48)`,
        tenant.userId,
      ],
    );
    const entryId = e.rows[0]?.id;
    if (!entryId) throw new Error('journal_entry insert returned no id');

    const byKey = new Map(
      st.positions.map((p) => [
        JSON.stringify([
          p.accountId,
          p.counterpartyId,
          p.documentNumber,
          p.costObjectId,
          p.currency,
        ]),
        p,
      ]),
    );
    let n = 0;
    const insert = (
      accountId: string,
      signed: Decimal,
      description: string,
      opening: boolean,
      p?: ConversionPosition,
    ) => {
      const foreign = p && p.isCurrency && p.currency && p.currency !== 'EUR';
      return c.query(
        `INSERT INTO app.journal_line (office_id, company_id, entry_id, line_no, account_id, side, amount,
                                       description, doc_currency, doc_amount, counterparty_id,
                                       document_number, document_date, cost_object_id, is_opening)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          tenant.officeId,
          tenant.companyId,
          entryId,
          ++n,
          accountId,
          signed.isNegative() ? 'C' : 'D',
          signed.abs().toFixed(2),
          description,
          foreign ? p.currency : null,
          foreign ? new Decimal(p.currencyBalance).abs().toFixed(2) : null,
          p?.counterpartyId ?? null,
          p?.documentNumber ?? null,
          p?.documentDate ?? null,
          p?.costObjectId ?? null,
          opening,
        ],
      );
    };
    for (const l of conv.lines) {
      const k = l.key;
      const p = byKey.get(
        JSON.stringify([
          k.accountId,
          k.counterpartyId,
          k.documentNumber,
          k.costObjectId,
          k.currency,
        ]),
      );
      const bgn = new Decimal(p?.bgn ?? '0');
      await insert(
        k.accountId,
        new Decimal(l.eur),
        `Начално салдо: ${bgn.abs().toFixed(2).replace('.', ',')} лв. ${bgn.isNegative() ? 'Кт' : 'Дт'}`,
        true,
        p,
      );
    }
    const equity = new Decimal(conv.equity);
    if (!equity.isZero()) {
      await insert(
        input.equityAccountId,
        equity,
        'Разлики от превалутиране на собствения капитал',
        true,
      );
    }
    const result = new Decimal(conv.result);
    if (!result.isZero()) {
      await insert(
        result.isNegative() ? input.gainAccountId : input.lossAccountId,
        result,
        result.isNegative()
          ? 'Положителни разлики от превалутиране (ЗВЕРБ, чл. 48, ал. 4)'
          : 'Отрицателни разлики от превалутиране (ЗВЕРБ, чл. 48, ал. 4)',
        true,
      );
    }
    await c.query(
      `INSERT INTO app.euro_conversion_run (office_id, company_id, from_year_id, to_year_id, entry_id,
                                            gain_account_id, loss_account_id, equity_account_id, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        tenant.officeId,
        tenant.companyId,
        st.from.id,
        st.to.id,
        entryId,
        input.gainAccountId,
        input.lossAccountId,
        input.equityAccountId,
        JSON.stringify(sourceOf(st.positions)),
      ],
    );
    const posted = await c.query<{ number: number }>(
      `UPDATE app.journal_entry SET status = 'posted' WHERE id = $1 RETURNING number`,
      [entryId],
    );
    const number = posted.rows[0]?.number;
    if (number === undefined) throw new Error('posting returned no number');
    return { ok: true, entryId, number, lines: n };
  });
}
