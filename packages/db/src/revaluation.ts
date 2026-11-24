import { fxRevaluation, type FxPosition, type FxRevaluation } from '@kantora/domain';
import type { Pool, PoolClient } from 'pg';
import type { ReportTenant } from './reports';
import { withTenant } from './tenant';

/**
 * Revaluation of foreign-currency positions at the end of a period (ADR-0015). The
 * positions are read and the entry is posted in ONE transaction, so nothing posted in
 * between is missed or counted twice. The conversion comes from the caller (published
 * rates in the app, fixed rates in the tests).
 */
export type FxConverter = {
  /** A POSITIVE amount of `currency` in the ledger currency, rounded to the cent. */
  convert: (currency: string, amount: string) => string;
  /** The rate as published, stored on the line for the record (null if none). */
  rate: (currency: string) => string | null;
};

export type FxPositions = {
  period: { id: string; endDate: string; locked: boolean; ledgerCurrency: string };
  positions: FxPosition[];
  /** Lines on currency accounts without a currency (posted before the account was marked). */
  withoutCurrency: { accountCode: string; lines: number }[];
};

async function readPositions(c: PoolClient, periodId: string): Promise<FxPositions | null> {
  const p = await c.query<{
    id: string;
    end_date: string;
    locked: boolean;
    ledger_currency: string;
  }>(
    `SELECT p.id, to_char(p.end_date, 'YYYY-MM-DD') AS end_date, p.locked_at IS NOT NULL AS locked,
            fy.ledger_currency
     FROM app.period p JOIN app.fiscal_year fy ON fy.id = p.fiscal_year_id WHERE p.id = $1`,
    [periodId],
  );
  const period = p.rows[0];
  if (!period) return null;
  const rows = await c.query<{
    account_id: string;
    code: string;
    currency: string | null;
    counterparty_id: string | null;
    document_number: string | null;
    cur: string;
    ledger: string;
    n: number;
  }>(
    `SELECT a.id AS account_id, a.code, l.doc_currency AS currency, l.counterparty_id,
            l.document_number,
            coalesce(sum(CASE l.side WHEN 'D' THEN l.doc_amount ELSE -l.doc_amount END), 0)::text AS cur,
            sum(CASE l.side WHEN 'D' THEN l.amount ELSE -l.amount END)::text AS ledger,
            count(*)::int AS n
     FROM app.journal_line l
     JOIN app.journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
     JOIN app.period lp ON lp.id = e.period_id
     JOIN app.account a ON a.id = l.account_id AND a.is_currency
     WHERE lp.fiscal_year_id = (SELECT fiscal_year_id FROM app.period WHERE id = $1)
       AND lp.month <= (SELECT month FROM app.period WHERE id = $1)
     GROUP BY a.id, a.code, l.doc_currency, l.counterparty_id, l.document_number`,
    [periodId],
  );
  const byCode = (x: string, y: string) => x.localeCompare(y, 'bg', { numeric: true });
  return {
    period: {
      id: period.id,
      endDate: period.end_date,
      locked: period.locked,
      ledgerCurrency: period.ledger_currency,
    },
    positions: rows.rows
      .filter((r) => r.currency !== null)
      .map((r) => ({
        accountId: r.account_id,
        accountCode: r.code,
        currency: r.currency ?? '',
        counterpartyId: r.counterparty_id,
        documentNumber: r.document_number,
        currencyBalance: r.cur,
        ledgerBalance: r.ledger,
      }))
      .sort(
        (a, b) =>
          byCode(a.accountCode, b.accountCode) ||
          a.currency.localeCompare(b.currency) ||
          (a.documentNumber ?? '').localeCompare(b.documentNumber ?? ''),
      ),
    withoutCurrency: rows.rows
      .filter((r) => r.currency === null)
      .map((r) => ({ accountCode: r.code, lines: r.n }))
      .sort((a, b) => byCode(a.accountCode, b.accountCode)),
  };
}

export async function fxPositions(
  pool: Pool,
  tenant: ReportTenant,
  periodId: string,
): Promise<FxPositions | null> {
  return withTenant(pool, tenant, (c) => readPositions(c, periodId));
}

export type FxRunResult =
  | { ok: true; entryId: string; number: number; revaluation: FxRevaluation }
  | { ok: false; error: string };

const isoToBg = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/**
 * Posts the revaluation of `periodId` as one entry dated the period's last day: a line
 * per position that changes (with its counterparty and document), the total gain credited
 * to `gainAccountId` and the total loss debited to `lossAccountId`.
 */
export async function runFxRevaluation(
  pool: Pool,
  tenant: ReportTenant,
  input: { periodId: string; gainAccountId: string; lossAccountId: string },
  fx: FxConverter,
): Promise<FxRunResult> {
  return withTenant(pool, tenant, async (c) => {
    const read = await readPositions(c, input.periodId);
    if (!read) return { ok: false, error: 'Периодът не е намерен.' };
    if (read.period.locked) {
      return {
        ok: false,
        error: 'Периодът е заключен: преоценка в него не може да се осчетоводи.',
      };
    }
    const rev = fxRevaluation(read.positions, fx.convert);
    if (rev.lines.length === 0) {
      return {
        ok: false,
        error: 'Няма разлики за осчетоводяване: позициите вече са по заключителния курс.',
      };
    }
    const date = read.period.endDate;
    const e = await c.query<{ id: string }>(
      `INSERT INTO app.journal_entry (office_id, company_id, period_id, entry_date, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        tenant.officeId,
        tenant.companyId,
        input.periodId,
        date,
        `Преоценка на валутните позиции към ${isoToBg(date)}`,
        tenant.userId,
      ],
    );
    const entryId = e.rows[0]?.id;
    if (!entryId) throw new Error('journal_entry insert returned no id');
    let n = 0;
    const line = (
      accountId: string,
      side: 'D' | 'C',
      amount: string,
      description: string,
      extra: {
        currency?: string;
        rate?: string | null;
        cp?: string | null;
        doc?: string | null;
      } = {},
    ) =>
      c.query(
        `INSERT INTO app.journal_line (office_id, company_id, entry_id, line_no, account_id, side, amount,
                                       description, doc_currency, doc_amount, fx_rate,
                                       counterparty_id, document_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          tenant.officeId,
          tenant.companyId,
          entryId,
          ++n,
          accountId,
          side,
          amount,
          description,
          extra.currency ?? null,
          extra.currency ? '0' : null,
          extra.rate ?? null,
          extra.cp ?? null,
          extra.doc ?? null,
        ],
      );
    for (const l of rev.lines) {
      const p = l.position;
      await line(
        p.accountId,
        l.side,
        l.amount,
        `Преоценка ${p.currency} ${p.currencyBalance.replace('-', '')}`,
        {
          currency: p.currency,
          rate: fx.rate(p.currency),
          cp: p.counterpartyId,
          doc: p.documentNumber,
        },
      );
    }
    if (rev.loss !== '0.00') {
      await line(input.lossAccountId, 'D', rev.loss, 'Отрицателни курсови разлики от преоценка');
    }
    if (rev.gain !== '0.00') {
      await line(input.gainAccountId, 'C', rev.gain, 'Положителни курсови разлики от преоценка');
    }
    await c.query(
      `INSERT INTO app.fx_revaluation_run (office_id, company_id, period_id, rate_date, entry_id,
                                           gain_account_id, loss_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tenant.officeId,
        tenant.companyId,
        input.periodId,
        date,
        entryId,
        input.gainAccountId,
        input.lossAccountId,
      ],
    );
    const posted = await c.query<{ number: number }>(
      `UPDATE app.journal_entry SET status = 'posted' WHERE id = $1 RETURNING number`,
      [entryId],
    );
    const number = posted.rows[0]?.number;
    if (number === undefined) throw new Error('posting returned no number');
    return { ok: true, entryId, number, revaluation: rev };
  });
}
