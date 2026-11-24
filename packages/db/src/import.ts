import {
  analyticsProblems,
  type ImportIssue,
  type ImportLine,
  type ParsedImport,
} from '@kantora/domain';
import { DatabaseError, type Pool } from 'pg';
import type { ReportTenant } from './reports';
import { withTenant } from './tenant';

/**
 * Applies an import from the Excel template (ADR-0017) in ONE transaction: accounts,
 * cost objects, counterparties, the opening balances of a year and the journal entries.
 * The preview runs exactly the same code and rolls back at the end, so what the preview
 * says is what the import will do, including every check of the database. Each entry is
 * tried under a savepoint, so all failing entries are reported, not just the first.
 * Nothing is written unless there is no issue at all.
 */
export type ImportSummary = {
  accounts: { added: number; existing: number };
  objects: { added: number; existing: number };
  counterparties: { added: number; existing: number };
  opening: { lines: number; year: number | null };
  entries: { posted: number; first: string | null; last: string | null };
};
export type ImportResult =
  | { ok: true; committed: boolean; summary: ImportSummary; runId: string | null }
  | { ok: false; issues: ImportIssue[]; summary: ImportSummary };

class Rollback extends Error {}

const emptySummary = (): ImportSummary => ({
  accounts: { added: 0, existing: 0 },
  objects: { added: 0, existing: 0 },
  counterparties: { added: 0, existing: 0 },
  opening: { lines: 0, year: null },
  entries: { posted: 0, first: null, last: null },
});

/** "Ред 2: …" from a database check of an entry → the file row of that line. */
function rowOf(message: string, lines: readonly ImportLine[], fallback: number): number {
  const m = /^Ред (\d+):/.exec(message);
  return m ? (lines[Number(m[1]) - 1]?.row ?? fallback) : fallback;
}
const dbMessage = (err: unknown) =>
  err instanceof DatabaseError &&
  ['23514', '22023', '42501', '23505', '23503'].includes(err.code ?? '')
    ? err.code === '23505'
      ? 'Такъв запис вече съществува.'
      : err.code === '23503'
        ? 'Препратка към несъществуващ запис.'
        : err.message
    : null;

export async function applyImport(
  pool: Pool,
  tenant: ReportTenant,
  parsed: ParsedImport,
  opts: {
    commit: boolean;
    fileName: string;
    sha256: string;
    /** The year whose opening balances the sheet "Начални салда" brings. */
    openingYear: number | null;
  },
): Promise<ImportResult> {
  const issues: ImportIssue[] = [...parsed.issues];
  const summary = emptySummary();
  let runId: string | null = null;
  try {
    await withTenant(pool, tenant, async (c) => {
      // Every check runs at once (not at COMMIT), so a failing entry can be rolled back to
      // its savepoint and reported with its rows.
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      const { officeId, companyId } = tenant;
      const add = (sheet: string, row: number, message: string) =>
        issues.push({ sheet, row, message });

      // The years (opening balances, entry dates).
      const years = (
        await c.query<{ id: string; year: number; start_date: string }>(
          `SELECT id, year, to_char(start_date, 'YYYY-MM-DD') AS start_date FROM app.fiscal_year`,
        )
      ).rows;
      const openingYear = parsed.opening.length
        ? years.find((y) => y.year === opts.openingYear)
        : undefined;
      if (parsed.opening.length && !openingYear) {
        add('Начални салда', 0, `Фирмата няма ${opts.openingYear ?? '?'} г. Изберете година.`);
      }

      const run = await c.query<{ id: string }>(
        `INSERT INTO app.import_run (office_id, company_id, file_name, file_sha256, summary, opening_year_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          officeId,
          companyId,
          opts.fileName.slice(0, 255) || 'внос.xlsx',
          opts.sha256,
          JSON.stringify({
            accounts: parsed.accounts.length,
            objects: parsed.objects.length,
            counterparties: parsed.counterparties.length,
            opening: parsed.opening.length,
            entries: parsed.entries.length,
          }),
          openingYear?.id ?? null,
        ],
      );
      runId = run.rows[0]?.id ?? null;

      // 1. Accounts: new codes are added; an existing code is kept as it is.
      const accounts = new Map(
        (
          await c.query<{
            id: string;
            code: string;
            needs_counterparty: boolean;
            needs_document: boolean;
            needs_cost_object: boolean;
          }>(
            'SELECT id, code, needs_counterparty, needs_document, needs_cost_object FROM app.account',
          )
        ).rows.map((a) => [a.code, a]),
      );
      for (const a of parsed.accounts) {
        if (accounts.has(a.code)) {
          summary.accounts.existing++;
          continue;
        }
        await c.query('SAVEPOINT acc');
        try {
          const r = await c.query<{ id: string }>(
            `INSERT INTO app.account (office_id, company_id, code, name, is_postable, needs_counterparty,
                                      needs_document, needs_cost_object, is_currency, euro_conversion)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
            [
              officeId,
              companyId,
              a.code,
              a.name,
              a.isPostable,
              a.needs.counterparty,
              a.needs.document,
              a.needs.costObject,
              a.isPostable && a.isCurrency,
              a.conversion,
            ],
          );
          accounts.set(a.code, {
            id: r.rows[0]?.id ?? '',
            code: a.code,
            needs_counterparty: a.needs.counterparty,
            needs_document: a.needs.document,
            needs_cost_object: a.needs.costObject,
          });
          summary.accounts.added++;
        } catch (err) {
          await c.query('ROLLBACK TO SAVEPOINT acc');
          const m = dbMessage(err);
          if (!m) throw err;
          add('Сметки', a.row, m);
        }
      }

      // 2. Cost objects by code.
      const objects = new Map(
        (
          await c.query<{ id: string; code: string }>('SELECT id, code FROM app.cost_object')
        ).rows.map((o) => [o.code, o.id]),
      );
      for (const o of parsed.objects) {
        if (objects.has(o.code)) {
          summary.objects.existing++;
          continue;
        }
        await c.query('SAVEPOINT obj');
        try {
          const r = await c.query<{ id: string }>(
            'INSERT INTO app.cost_object (office_id, company_id, code, name) VALUES ($1, $2, $3, $4) RETURNING id',
            [officeId, companyId, o.code, o.name],
          );
          objects.set(o.code, r.rows[0]?.id ?? '');
          summary.objects.added++;
        } catch (err) {
          await c.query('ROLLBACK TO SAVEPOINT obj');
          if (!dbMessage(err)) throw err;
          add(
            'Обекти',
            o.row,
            'Невалиден код или наименование на обект (код до 30 знака: букви, цифри, . / -).',
          );
        }
      }

      // 3. Counterparties: the same EIK, or (without EIK) the same name, is the same one.
      const cps = (
        await c.query<{ id: string; name: string; eik: string | null }>(
          'SELECT id, name, eik FROM app.counterparty',
        )
      ).rows;
      const byEik = new Map(cps.filter((x) => x.eik).map((x) => [x.eik as string, x.id]));
      const byName = new Map<string, string[]>();
      const addName = (name: string, id: string) =>
        byName.set(name.toLowerCase(), [...(byName.get(name.toLowerCase()) ?? []), id]);
      for (const x of cps) addName(x.name, x.id);
      for (const cp of parsed.counterparties) {
        const existing = cp.eik ? byEik.get(cp.eik) : byName.get(cp.name.toLowerCase())?.[0];
        if (existing) {
          summary.counterparties.existing++;
          continue;
        }
        await c.query('SAVEPOINT cp');
        let id: string;
        try {
          const r = await c.query<{ id: string }>(
            `INSERT INTO app.counterparty (office_id, company_id, name, eik, vat_number, country, address)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [officeId, companyId, cp.name, cp.eik, cp.vatNumber, cp.country, cp.address],
          );
          id = r.rows[0]?.id ?? '';
        } catch (err) {
          await c.query('ROLLBACK TO SAVEPOINT cp');
          const m = dbMessage(err);
          if (!m) throw err;
          add('Контрагенти', cp.row, m);
          continue;
        }
        if (cp.eik) byEik.set(cp.eik, id);
        addName(cp.name, id);
        summary.counterparties.added++;
      }

      /** Resolves the references of a line; reports what is missing. */
      const resolve = (l: ImportLine) => {
        const a = accounts.get(l.account);
        const errs: string[] = [];
        if (!a)
          errs.push(`няма сметка ${l.account} (добавете я на листа „Сметки“ или в сметкоплана)`);
        let cpId: string | null = null;
        if (l.counterparty) {
          const key = l.counterparty.replace(/\s+/g, '');
          const hits = /^\d{9}(\d{4})?$/.test(key)
            ? byEik.get(key)
              ? [byEik.get(key) as string]
              : []
            : (byName.get(l.counterparty.toLowerCase()) ?? []);
          if (hits.length === 1) cpId = hits[0] ?? null;
          else if (hits.length === 0) errs.push(`няма контрагент „${l.counterparty}“`);
          else errs.push(`„${l.counterparty}“ е име на няколко контрагенти: посочете ЕИК`);
        }
        let objId: string | null = null;
        if (l.costObject) {
          objId = objects.get(l.costObject) ?? null;
          if (!objId) errs.push(`няма обект „${l.costObject}“`);
        }
        return { a, cpId, objId, errs };
      };

      async function insertEntry(
        sheet: string,
        firstRow: number,
        lines: readonly ImportLine[],
        entry: { date: string; description: string; opening: boolean; label: string },
      ): Promise<boolean> {
        const resolved = lines.map(resolve);
        let bad = false;
        resolved.forEach((r, i) => {
          const l = lines[i];
          if (l && r.errs.length) {
            bad = true;
            add(
              sheet,
              l.row,
              `${r.errs.join('; ')}.`.replace(/^./, (x) => x.toUpperCase()),
            );
          }
        });
        if (bad) return false;
        // Analytics the accounts need, with file rows (the database checks again).
        if (!entry.opening) {
          const missing = analyticsProblems(
            lines.map((l, i) => {
              const a = resolved[i]?.a;
              return {
                accountCode: l.account,
                needs: {
                  counterparty: !!a?.needs_counterparty,
                  document: !!a?.needs_document,
                  costObject: !!a?.needs_cost_object,
                },
                counterpartyId: resolved[i]?.cpId ?? null,
                documentNumber: l.documentNumber,
                documentDate: l.documentDate,
                costObjectId: resolved[i]?.objId ?? null,
              };
            }),
          );
          if (missing.length) {
            for (const m of missing)
              add(
                sheet,
                rowOf(m.message, lines, firstRow),
                `${entry.label}: ${m.message.replace(/^Ред \d+: /, '')}`,
              );
            return false;
          }
        }
        const period = await c.query<{ id: string }>(
          'SELECT id FROM app.period WHERE $1::date BETWEEN start_date AND end_date',
          [entry.date],
        );
        const periodId = period.rows[0]?.id;
        if (!periodId) {
          add(
            sheet,
            firstRow,
            `${entry.label}: фирмата няма период за ${entry.date.split('-').reverse().join('.')}.`,
          );
          return false;
        }
        await c.query('SAVEPOINT entry');
        try {
          const e = await c.query<{ id: string }>(
            `INSERT INTO app.journal_entry (office_id, company_id, period_id, entry_date, description,
                                            created_by, import_run_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [officeId, companyId, periodId, entry.date, entry.description, tenant.userId, runId],
          );
          const id = e.rows[0]?.id;
          let n = 0;
          for (const [i, l] of lines.entries()) {
            const r = resolved[i];
            await c.query(
              `INSERT INTO app.journal_line (office_id, company_id, entry_id, line_no, account_id, side, amount,
                                             description, counterparty_id, document_number, document_date,
                                             cost_object_id, doc_currency, doc_amount, is_opening)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
              [
                officeId,
                companyId,
                id,
                ++n,
                r?.a?.id,
                l.side,
                l.amount,
                l.description,
                r?.cpId ?? null,
                l.documentNumber,
                l.documentDate,
                r?.objId ?? null,
                l.currency,
                l.currency ? l.currencyAmount : null,
                entry.opening,
              ],
            );
          }
          await c.query(`UPDATE app.journal_entry SET status = 'posted' WHERE id = $1`, [id]);
          await c.query('RELEASE SAVEPOINT entry');
          return true;
        } catch (err) {
          await c.query('ROLLBACK TO SAVEPOINT entry');
          const m = dbMessage(err);
          if (!m) throw err;
          add(sheet, rowOf(m, lines, firstRow), `${entry.label}: ${m.replace(/^Ред \d+: /, '')}`);
          return false;
        }
      }

      // 4. Opening balances: one entry on the first day of the year.
      if (parsed.opening.length && openingYear) {
        const first = parsed.opening[0];
        const ok = await insertEntry(
          first?.sheet ?? 'Начални салда',
          first?.row ?? 0,
          parsed.opening,
          {
            date: openingYear.start_date,
            description: `Начални салда към ${openingYear.start_date.split('-').reverse().join('.')} (внос)`,
            opening: true,
            label: 'Начални салда',
          },
        );
        if (ok) summary.opening = { lines: parsed.opening.length, year: openingYear.year };
      }

      // 5. Entries in date order (numbers follow the posting order).
      const entries = [...parsed.entries].sort(
        (x, y) => x.date.localeCompare(y.date) || x.row - y.row,
      );
      for (const e of entries) {
        const ok = await insertEntry(e.lines[0]?.sheet ?? 'Статии', e.row, e.lines, {
          date: e.date,
          description: e.description,
          opening: false,
          label: `Статия ${e.key}`,
        });
        if (ok) {
          summary.entries.posted++;
          summary.entries.first ??= e.date;
          summary.entries.last = e.date;
        }
      }

      if (issues.length > 0 || !opts.commit) throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  if (issues.length > 0) {
    return {
      ok: false,
      issues: issues.sort((a, b) => a.sheet.localeCompare(b.sheet, 'bg') || a.row - b.row),
      summary,
    };
  }
  return { ok: true, committed: opts.commit, summary, runId: opts.commit ? runId : null };
}
