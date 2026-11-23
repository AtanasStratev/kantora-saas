/**
 * Every report reconciles with the journal (PROMPT.md 3.5), through THE SAME SQL the screens
 * and the Excel/PDF files use (src/reports.ts):
 *   - the trial balance equals an independent computation (domain/journal.ts) from raw lines;
 *   - the general ledger equals the trial balance account by account, and each account's
 *     lines equal its account card;
 *   - the chronological register holds every posted line once, and its totals equal the
 *     trial balance turnover.
 * Drafts, reversals and multi-line entries are included on purpose; another office sees nothing.
 */
import { randomUUID } from 'node:crypto';
import { trialBalance as domainTrialBalance, type PostedLine } from '@kantora/domain';
import Decimal from 'decimal.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accountCard,
  chronologicalRegister,
  generalLedger,
  journalList,
  trialBalance,
  type ReportTenant,
} from './reports';
import { withTenant, withUser } from './tenant';

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const YEAR = new Date().getFullYear();
const CODES = ['501', '401', '601', '702', '411'];

async function company(): Promise<{
  t: ReportTenant;
  acc: Record<string, string>;
  periods: Record<number, string>;
}> {
  const userId = randomUUID();
  await admin.query(
    'INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)',
    [userId, 'Т', `${userId}@test.local`],
  );
  const officeId = await withUser(
    app,
    userId,
    async (c) =>
      (await c.query<{ id: string }>(`SELECT app.register_office('Справки') AS id`)).rows[0]!.id,
  );
  const companyId = await withTenant(
    app,
    { userId, officeId },
    async (c) =>
      (await c.query<{ id: string }>(`SELECT app.create_company('Справки ООД') AS id`)).rows[0]!.id,
  );
  const t = { userId, officeId, companyId };
  const acc: Record<string, string> = {};
  const periods: Record<number, string> = {};
  await withTenant(app, t, async (c) => {
    // Illustrative test accounts only (the real chart comes from the pilot).
    for (const code of CODES) {
      const r = await c.query<{ id: string }>(
        `INSERT INTO app.account (office_id, company_id, code, name, is_postable)
         VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [officeId, companyId, code, `Сметка ${code}`],
      );
      acc[code] = r.rows[0]!.id;
    }
    for (const r of (
      await c.query<{ id: string; month: number }>('SELECT id, month FROM app.period')
    ).rows) {
      periods[r.month] = r.id;
    }
  });
  return { t, acc, periods };
}

let w: Awaited<ReturnType<typeof company>>;

beforeAll(async () => {
  w = await company();
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const cents = () => {
    const n = Math.floor(rnd() * 900_000) + 1;
    return new Decimal(n).div(100).toFixed(2);
  };
  const posted: string[] = [];
  // One transaction: Dt = Кт is checked at commit for every entry.
  await withTenant(app, w.t, async (c) => {
    for (let i = 0; i < 120; i++) {
      const month = Math.floor(rnd() * 12) + 1;
      const day = Math.floor(rnd() * 28) + 1;
      const date = `${YEAR}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const pick = () => CODES[Math.floor(rnd() * CODES.length)]!;
      // Two or three lines: D a = C b (+ C c), so every entry balances.
      const a = cents();
      const lines: [string, 'D' | 'C', string][] = [];
      if (rnd() < 0.3) {
        const b = cents();
        lines.push(
          [pick(), 'D', new Decimal(a).plus(b).toFixed(2)],
          [pick(), 'C', a],
          [pick(), 'C', b],
        );
      } else {
        lines.push([pick(), 'D', a], [pick(), 'C', a]);
      }
      const e = await c.query<{ id: string }>(
        `INSERT INTO app.journal_entry (office_id, company_id, period_id, entry_date, description, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [w.t.officeId, w.t.companyId, w.periods[month], date, `Операция ${i}`, w.t.userId],
      );
      const id = e.rows[0]!.id;
      let n = 0;
      for (const [code, side, amount] of lines) {
        await c.query(
          `INSERT INTO app.journal_line (office_id, company_id, entry_id, line_no, account_id, side, amount, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [w.t.officeId, w.t.companyId, id, ++n, w.acc[code], side, amount, n === 2 ? 'ред' : ''],
        );
      }
      // Every 10th entry stays a draft: not in the books, not in any report.
      if (i % 10 !== 9) {
        await c.query(`UPDATE app.journal_entry SET status = 'posted' WHERE id = $1`, [id]);
        posted.push(id);
      }
    }
  });
  // Reversals in the same month as the original.
  await withTenant(app, w.t, async (c) => {
    for (const id of posted.slice(0, 5)) {
      const d = await c.query<{ d: string }>(
        `SELECT to_char(entry_date, 'YYYY-MM-DD') AS d FROM app.journal_entry WHERE id = $1`,
        [id],
      );
      await c.query('SELECT app.reverse_entry($1, $2)', [id, d.rows[0]!.d]);
    }
  });
}, 120_000);

/** Raw posted lines, read without any report code. */
async function rawLines(): Promise<(PostedLine & { month: number; entryId: string })[]> {
  return withTenant(app, w.t, async (c) =>
    (
      await c.query<{
        code: string;
        side: 'D' | 'C';
        amount: string;
        date: string;
        month: number;
        entry_id: string;
      }>(
        `SELECT a.code, l.side, l.amount::text AS amount, to_char(e.entry_date, 'YYYY-MM-DD') AS date,
                extract(month FROM e.entry_date)::int AS month, e.id AS entry_id
         FROM app.journal_line l JOIN app.journal_entry e ON e.id = l.entry_id
         JOIN app.account a ON a.id = l.account_id WHERE e.status = 'posted'`,
      )
    ).rows.map((r) => ({
      accountCode: r.code,
      side: r.side,
      amount: r.amount,
      date: r.date,
      month: r.month,
      entryId: r.entry_id,
    })),
  );
}

const lastDay = (m: number) => new Date(Date.UTC(YEAR, m, 0)).getUTCDate();
const iso = (m: number, d: number) =>
  `${YEAR}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const RANGES: [number, number][] = [
  [1, 1],
  [4, 6],
  [11, 11],
  [1, 12],
];

describe.each(RANGES)('months %i–%i', (from, to) => {
  // Any period of the year identifies the fiscal year.
  const pid = () => w.periods[to]!;

  it('trial balance (SQL) = independent domain computation from raw lines', async () => {
    const tb = await trialBalance(app, w.t, pid(), from, to);
    const dom = domainTrialBalance(await rawLines(), iso(from, 1), iso(to, lastDay(to)));
    expect(
      tb.rows.map((r) =>
        [r.code, r.od, r.oc, r.td, r.tc, r.cd, r.cc].map((v, i) =>
          i ? new Decimal(v).toFixed(2) : v,
        ),
      ),
    ).toEqual(
      dom.rows.map((r) => [
        r.accountCode,
        r.openingDebit,
        r.openingCredit,
        r.turnoverDebit,
        r.turnoverCredit,
        r.closingDebit,
        r.closingCredit,
      ]),
    );
    expect(tb.reconciled).toBe(true);
    expect(tb.totals.td).toBe(dom.totals.turnoverDebit);
  });

  it('general ledger = trial balance per account; its lines = the account card', async () => {
    const tb = await trialBalance(app, w.t, pid(), from, to);
    const gl = await generalLedger(app, w.t, pid(), from, to);
    expect(gl.accounts.map((a) => a.code)).toEqual(tb.rows.map((r) => r.code));
    for (const a of gl.accounts) {
      const r = tb.rows.find((x) => x.account_id === a.account_id)!;
      expect(new Decimal(a.opening).eq(new Decimal(r.od).minus(r.oc)), `${a.code} opening`).toBe(
        true,
      );
      expect(new Decimal(a.td).eq(r.td), `${a.code} td`).toBe(true);
      expect(new Decimal(a.tc).eq(r.tc), `${a.code} tc`).toBe(true);
      expect(new Decimal(a.closing).eq(new Decimal(r.cd).minus(r.cc)), `${a.code} closing`).toBe(
        true,
      );

      const card = await accountCard(app, w.t, a.account_id, pid(), from, to);
      expect(card.lines.map((l) => [l.entry_id, l.side, l.amount])).toEqual(
        a.lines.map((l) => [l.entry_id, l.side, l.amount]),
      );
      expect(new Decimal(card.closing).eq(a.closing), `${a.code} card closing`).toBe(true);
    }
    expect(gl.totals.td).toBe(new Decimal(tb.totals.td).toFixed(2));
    expect(gl.totals.td).toBe(gl.totals.tc);
  });

  it('chronological register: every posted line once, in date order; totals = turnover', async () => {
    const tb = await trialBalance(app, w.t, pid(), from, to);
    const reg = await chronologicalRegister(app, w.t, pid(), from, to);
    const raw = (await rawLines()).filter((l) => l.month >= from && l.month <= to);
    expect(reg.lines.length).toBe(raw.length);
    expect(reg.entries).toBe(new Set(raw.map((l) => l.entryId)).size);
    const dates = reg.lines.map((l) => l.entry_date);
    expect(dates).toEqual([...dates].sort());
    expect(reg.totals.d).toBe(reg.totals.c);
    expect(reg.totals.d).toBe(new Decimal(tb.totals.td).toFixed(2));
    expect(reg.totals.c).toBe(new Decimal(tb.totals.tc).toFixed(2));
  });
});

describe('what is and is not in the reports', () => {
  it('drafts never appear; reversals do, with the reversed number', async () => {
    const reg = await chronologicalRegister(app, w.t, w.periods[12]!, 1, 12);
    const drafts = await withTenant(app, w.t, async (c) =>
      (
        await c.query<{ id: string }>(`SELECT id FROM app.journal_entry WHERE status <> 'posted'`)
      ).rows.map((r) => r.id),
    );
    expect(drafts.length).toBe(12);
    expect(reg.lines.some((l) => drafts.includes(l.entry_id))).toBe(false);
    expect(
      new Set(reg.lines.filter((l) => l.reverses_number !== null).map((l) => l.entry_id)).size,
    ).toBe(5);
  });

  it('the journal list of a month has the same entries as the register of that month', async () => {
    for (const m of [3, 7]) {
      const list = await journalList(app, w.t, w.periods[m]!);
      const reg = await chronologicalRegister(app, w.t, w.periods[m]!, m, m);
      expect(new Set(list.map((r) => r.id))).toEqual(new Set(reg.lines.map((l) => l.entry_id)));
    }
  });

  it('another office sees nothing (RLS), even with the period id', async () => {
    const other = await company();
    const t = other.t;
    expect((await trialBalance(app, t, w.periods[12]!, 1, 12)).rows).toEqual([]);
    expect((await generalLedger(app, t, w.periods[12]!, 1, 12)).accounts).toEqual([]);
    expect((await chronologicalRegister(app, t, w.periods[12]!, 1, 12)).lines).toEqual([]);
    const someAccount = w.acc['501']!;
    const card = await accountCard(app, t, someAccount, w.periods[12]!, 1, 12);
    expect([card.account, card.lines]).toEqual([undefined, []]);
  });
});

describe('RLS cost (migration 20261123100000)', () => {
  it('no company-scoped policy calls an access function per row', async () => {
    const r = await admin.query<{ t: string; p: string }>(
      `SELECT c.relname AS t, p.polname AS p
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'app'
         AND concat(pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid))
             LIKE '%has_company_access(office_id, company_id)%'`,
    );
    expect(r.rows).toEqual([]);
  });
});
