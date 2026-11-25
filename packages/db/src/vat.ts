import {
  vatDocumentProblems,
  vatPostingLines,
  type VatDirection,
  type VatDocumentKind,
  type VatLine,
  type VatSettings,
} from '@kantora/domain';
import Decimal from 'decimal.js';
import { DatabaseError, type Pool, type PoolClient } from 'pg';
import type { ReportTenant } from './reports';
import { withTenant } from './tenant';

/**
 * VAT documents (ADR-0018): the rates valid on a date (only from legal_parameter), the
 * company's VAT settings, and saving + posting a document with its journal entry in ONE
 * transaction. The database checks the rates again when the document is posted.
 */
export type VatRate = { key: string; percent: string; sourceRef: string };

export async function vatRates(c: PoolClient, date: string): Promise<VatRate[]> {
  const r = await c.query<{ key: string; percent: string; source_ref: string }>(
    `SELECT key, value_numeric::text AS percent, source_ref FROM app.legal_parameter
     WHERE key LIKE 'vat\\_rate\\_%' AND value_numeric IS NOT NULL
       AND valid_from <= $1 AND (valid_to IS NULL OR $1 <= valid_to)
     ORDER BY value_numeric DESC, key`,
    [date],
  );
  return r.rows.map((x) => ({
    key: x.key,
    percent: new Decimal(x.percent).toString(),
    sourceRef: x.source_ref,
  }));
}

export async function loadVatSettings(c: PoolClient): Promise<VatSettings> {
  const r = await c.query<{
    input_vat_account_id: string | null;
    output_vat_account_id: string | null;
    supplier_account_id: string | null;
    customer_account_id: string | null;
  }>(
    'SELECT input_vat_account_id, output_vat_account_id, supplier_account_id, customer_account_id FROM app.vat_setting',
  );
  const s = r.rows[0];
  return {
    inputVatAccountId: s?.input_vat_account_id ?? null,
    outputVatAccountId: s?.output_vat_account_id ?? null,
    supplierAccountId: s?.supplier_account_id ?? null,
    customerAccountId: s?.customer_account_id ?? null,
  };
}

export async function saveVatSettings(
  pool: Pool,
  tenant: ReportTenant,
  s: VatSettings,
): Promise<void> {
  await withTenant(pool, tenant, (c) =>
    c.query(
      `INSERT INTO app.vat_setting (office_id, company_id, input_vat_account_id, output_vat_account_id,
                                    supplier_account_id, customer_account_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (company_id) DO UPDATE SET
         input_vat_account_id = EXCLUDED.input_vat_account_id,
         output_vat_account_id = EXCLUDED.output_vat_account_id,
         supplier_account_id = EXCLUDED.supplier_account_id,
         customer_account_id = EXCLUDED.customer_account_id`,
      [
        tenant.officeId,
        tenant.companyId,
        s.inputVatAccountId,
        s.outputVatAccountId,
        s.supplierAccountId,
        s.customerAccountId,
      ],
    ),
  );
}

export type VatDocumentInput = {
  direction: VatDirection;
  kind: VatDocumentKind;
  number: string;
  issueDate: string;
  taxEventDate: string;
  counterpartyId: string;
  relatedId: string | null;
  lines: { accountId: string; description: string; net: string; rateKey: string; vat: string }[];
};

export type VatPostResult =
  | { ok: true; documentId: string; entryId: string; entryNumber: number }
  | { ok: false; problems: string[] };

const KIND_WORD: Record<VatDocumentKind, string> = {
  invoice: 'Фактура',
  debit_note: 'ДИ',
  credit_note: 'КИ',
};

/** Saves the document and posts it with its entry, or changes nothing. */
export async function postVatDocument(
  pool: Pool,
  tenant: ReportTenant,
  input: VatDocumentInput,
): Promise<VatPostResult> {
  try {
    return await withTenant(pool, tenant, async (c) => {
      const settings = await loadVatSettings(c);
      const rates = new Map((await vatRates(c, input.taxEventDate)).map((r) => [r.key, r.percent]));
      const accounts = new Map(
        (
          await c.query<{ id: string; code: string }>(
            'SELECT id, code FROM app.account WHERE id = ANY($1)',
            [input.lines.map((l) => l.accountId)],
          )
        ).rows.map((a) => [a.id, a.code]),
      );
      const problems: string[] = [];
      const lines: VatLine[] = input.lines.map((l, i) => {
        const percent = rates.get(l.rateKey);
        if (percent === undefined) {
          problems.push(
            `Ред ${i + 1}: няма проверена ставка „${l.rateKey}“ към ${input.taxEventDate.split('-').reverse().join('.')}.`,
          );
        }
        if (!accounts.has(l.accountId)) problems.push(`Ред ${i + 1}: изберете сметка.`);
        return {
          accountId: l.accountId,
          accountCode: accounts.get(l.accountId) ?? '',
          description: l.description,
          net: l.net,
          rateKey: l.rateKey,
          ratePercent: percent ?? '0',
          vat: l.vat,
        };
      });
      if (problems.length) return { ok: false, problems };
      problems.push(...vatDocumentProblems(input.direction, lines, settings).map((p) => p.message));
      if (problems.length) return { ok: false, problems };

      const period = await c.query<{ id: string }>(
        'SELECT id FROM app.period WHERE $1::date BETWEEN start_date AND end_date',
        [input.taxEventDate],
      );
      const periodId = period.rows[0]?.id;
      if (!periodId)
        return { ok: false, problems: ['За датата на данъчното събитие фирмата няма период.'] };

      const d = await c.query<{ id: string }>(
        `INSERT INTO app.vat_document (office_id, company_id, direction, kind, number, issue_date, tax_event_date,
                                       counterparty_id, related_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          tenant.officeId,
          tenant.companyId,
          input.direction,
          input.kind,
          input.number.trim(),
          input.issueDate,
          input.taxEventDate,
          input.counterpartyId,
          input.relatedId,
        ],
      );
      const documentId = d.rows[0]?.id;
      if (!documentId) throw new Error('vat_document insert returned no id');
      let n = 0;
      for (const l of lines) {
        await c.query(
          `INSERT INTO app.vat_document_line (office_id, company_id, document_id, line_no, account_id, description,
                                              net_amount, rate_key, rate_percent, vat_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            tenant.officeId,
            tenant.companyId,
            documentId,
            ++n,
            l.accountId,
            l.description,
            l.net,
            l.rateKey,
            l.ratePercent,
            l.vat,
          ],
        );
      }

      const e = await c.query<{ id: string }>(
        `INSERT INTO app.journal_entry (office_id, company_id, period_id, entry_date, description, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          tenant.officeId,
          tenant.companyId,
          periodId,
          input.taxEventDate,
          `${KIND_WORD[input.kind]} № ${input.number.trim()} (${input.direction === 'purchase' ? 'покупка' : 'продажба'})`,
          tenant.userId,
        ],
      );
      const entryId = e.rows[0]?.id;
      if (!entryId) throw new Error('journal_entry insert returned no id');
      let k = 0;
      for (const p of vatPostingLines(input.direction, input.kind, lines, settings)) {
        await c.query(
          `INSERT INTO app.journal_line (office_id, company_id, entry_id, line_no, account_id, side, amount, description,
                                         counterparty_id, document_number, document_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            tenant.officeId,
            tenant.companyId,
            entryId,
            ++k,
            p.accountId,
            p.side,
            p.amount,
            p.description,
            p.withDocument ? input.counterpartyId : null,
            p.withDocument ? input.number.trim() : null,
            p.withDocument ? input.issueDate : null,
          ],
        );
      }
      const posted = await c.query<{ number: number }>(
        `UPDATE app.journal_entry SET status = 'posted' WHERE id = $1 RETURNING number`,
        [entryId],
      );
      await c.query(`UPDATE app.vat_document SET status = 'posted', entry_id = $2 WHERE id = $1`, [
        documentId,
        entryId,
      ]);
      return { ok: true, documentId, entryId, entryNumber: posted.rows[0]?.number ?? 0 };
    });
  } catch (err) {
    if (err instanceof DatabaseError) {
      if (err.code === '23505') return { ok: false, problems: ['Документ с този номер вече има.'] };
      if (['23514', '22023', '42501'].includes(err.code ?? ''))
        return { ok: false, problems: [err.message] };
    }
    throw err;
  }
}

export type VatDocumentRow = {
  id: string;
  direction: VatDirection;
  kind: VatDocumentKind;
  number: string;
  issue_date: string;
  tax_event_date: string;
  counterparty: string;
  net: string;
  vat: string;
  entry_id: string | null;
  entry_number: number | null;
};

/** Documents whose tax event is in the period. */
export async function vatDocuments(
  pool: Pool,
  tenant: ReportTenant,
  periodId: string,
): Promise<VatDocumentRow[]> {
  return withTenant(
    pool,
    tenant,
    async (c) =>
      (
        await c.query<VatDocumentRow>(
          `SELECT d.id, d.direction, d.kind, d.number, to_char(d.issue_date, 'YYYY-MM-DD') AS issue_date,
                to_char(d.tax_event_date, 'YYYY-MM-DD') AS tax_event_date, cp.name AS counterparty,
                coalesce(sum(l.net_amount), 0)::text AS net, coalesce(sum(l.vat_amount), 0)::text AS vat,
                d.entry_id, e.number AS entry_number
         FROM app.vat_document d
         JOIN app.counterparty cp ON cp.id = d.counterparty_id
         JOIN app.period p ON p.id = $1 AND d.tax_event_date BETWEEN p.start_date AND p.end_date
         LEFT JOIN app.vat_document_line l ON l.document_id = d.id
         LEFT JOIN app.journal_entry e ON e.id = d.entry_id
         GROUP BY d.id, cp.name, e.number
         ORDER BY d.direction, d.tax_event_date, d.number`,
          [periodId],
        )
      ).rows,
  );
}
