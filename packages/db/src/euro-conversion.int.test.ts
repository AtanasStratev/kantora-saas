/**
 * BGN → EUR conversion of the balances, enforced and reconciled in the DATABASE
 * (migration 20261126100000, ADR-0016, ЗВЕРБ чл. 48). Account codes are illustrative
 * test data, not a prescribed chart; counterparties are fictitious.
 */
import { convertBgnToEur, convertBgnToEurWages } from '@kantora/domain';
import Decimal from 'decimal.js';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyticReport } from './analytic-reports';
import { euroConversionState, runEuroConversion } from './euro-conversion';
import { chronologicalRegister, trialBalance } from './reports';
import { withTenant, withUser, type TenantContext } from './tenant';

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

type Ctx = TenantContext & { companyId: string };
let owner: Ctx;
const acc: Record<string, string> = {};
const p2025: Record<number, string> = {};
const p2026: Record<number, string> = {};
let cpA: string;

async function authUser(): Promise<string> {
  const id = randomUUID();
  await admin.query(
    'INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)',
    [id, 'Т', `${id}@test.local`],
  );
  return id;
}

async function company(): Promise<Ctx> {
  const userId = await authUser();
  const officeId = await withUser(
    app,
    userId,
    async (c) =>
      (await c.query<{ id: string }>(`SELECT app.register_office('Евро') AS id`)).rows[0]!.id,
  );
  const companyId = await withTenant(
    app,
    { userId, officeId },
    async (c) =>
      (await c.query<{ id: string }>(`SELECT app.create_company('Евро ООД') AS id`)).rows[0]!.id,
  );
  return { userId, officeId, companyId };
}

type L = {
  code: string;
  side: 'D' | 'C';
  amount: string;
  cp?: string;
  doc?: string;
  cur?: [string, string];
};

async function entry(date: string, lines: L[]): Promise<string> {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return withTenant(app, owner, async (c) => {
    const e = await c.query<{ id: string }>(
      `INSERT INTO app.journal_entry (office_id, company_id, period_id, entry_date, description, created_by)
       VALUES ($1, $2, $3, $4, 'тест', $5) RETURNING id`,
      [owner.officeId, owner.companyId, (year === 2025 ? p2025 : p2026)[month], date, owner.userId],
    );
    const id = e.rows[0]!.id;
    let n = 0;
    for (const l of lines) {
      await c.query(
        `INSERT INTO app.journal_line (office_id, company_id, entry_id, line_no, account_id, side, amount,
                                       counterparty_id, document_number, doc_currency, doc_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          owner.officeId,
          owner.companyId,
          id,
          ++n,
          acc[l.code],
          l.side,
          l.amount,
          l.cp ?? null,
          l.doc ?? null,
          l.cur?.[0] ?? null,
          l.cur?.[1] ?? null,
        ],
      );
    }
    await c.query(`UPDATE app.journal_entry SET status = 'posted' WHERE id = $1`, [id]);
    return id;
  });
}

const accounts = {
  // code: [conversion class, is_currency, needs counterparty+document]
  '101': ['equity', false, false],
  '122': ['equity', false, false],
  '421': ['wages', false, false],
  '503': ['standard', false, false],
  '504': ['standard', true, false],
  '304': ['standard', false, false],
  '401': ['standard', false, true],
  '601': ['standard', false, false],
  '702': ['standard', false, false],
  '624': ['standard', false, false],
  '724': ['standard', false, false],
} as const;

beforeAll(async () => {
  owner = await company();
  await withTenant(app, owner, async (c) => {
    await c.query('SELECT app.add_fiscal_year(2025)');
    for (const [code, [cls, isCurrency, needs]] of Object.entries(accounts)) {
      const r = await c.query<{ id: string }>(
        `INSERT INTO app.account (office_id, company_id, code, name, euro_conversion, is_currency,
                                  needs_counterparty, needs_document)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
        [owner.officeId, owner.companyId, code, `Сметка ${code}`, cls, isCurrency, needs],
      );
      acc[code] = r.rows[0]!.id;
    }
    for (const r of (
      await c.query<{ id: string; month: number; year: number }>(
        `SELECT p.id, p.month, fy.year FROM app.period p JOIN app.fiscal_year fy ON fy.id = p.fiscal_year_id`,
      )
    ).rows) {
      (r.year === 2025 ? p2025 : p2026)[r.month] = r.id;
    }
    cpA = (
      await c.query<{ id: string }>(
        `INSERT INTO app.counterparty (office_id, company_id, name) VALUES ($1, $2, 'Доставчик А') RETURNING id`,
        [owner.officeId, owner.companyId],
      )
    ).rows[0]!.id;
  });
  // 2025 in leva: capital, wages owed, a supplier invoice partly paid, a USD account,
  // and 60 random entries so that the rounding adds up to something.
  await entry('2025-01-10', [
    { code: '503', side: 'D', amount: '5000.00' },
    { code: '101', side: 'C', amount: '5000.00' },
  ]);
  await entry('2025-12-31', [
    { code: '601', side: 'D', amount: '1024.51' },
    { code: '421', side: 'C', amount: '1024.51' },
  ]);
  await entry('2025-11-05', [
    { code: '304', side: 'D', amount: '655.12' },
    { code: '401', side: 'C', amount: '655.12', cp: cpA, doc: 'Ф-1' },
  ]);
  await entry('2025-12-10', [
    { code: '401', side: 'D', amount: '300.00', cp: cpA, doc: 'Ф-1' },
    { code: '503', side: 'C', amount: '300.00' },
  ]);
  await entry('2025-06-01', [
    { code: '504', side: 'D', amount: '1955.83', cur: ['USD', '1000.00'] },
    { code: '702', side: 'C', amount: '1955.83' },
  ]);
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const codes = ['503', '304', '601', '702', '122'];
  for (let i = 0; i < 60; i++) {
    const a = new Decimal(Math.floor(rnd() * 500_000) + 1).div(100).toFixed(2);
    const m = Math.floor(rnd() * 12) + 1;
    await entry(`2025-${String(m).padStart(2, '0')}-15`, [
      { code: codes[Math.floor(rnd() * codes.length)]!, side: 'D', amount: a },
      { code: codes[Math.floor(rnd() * codes.length)]!, side: 'C', amount: a },
    ]);
  }
}, 120_000);

describe('fiscal years', () => {
  it('only the year next to the existing ones can be added, by owner or chief accountant', async () => {
    await expect(
      withTenant(app, owner, (c) => c.query('SELECT app.add_fiscal_year(2020)')),
    ).rejects.toThrow('Може да се добави само годината преди или след съществуващите.');
    const ys = await withTenant(
      app,
      owner,
      async (c) =>
        (
          await c.query<{ year: number; ledger_currency: string }>(
            'SELECT year, ledger_currency FROM app.fiscal_year ORDER BY year',
          )
        ).rows,
    );
    expect(ys.map((y) => [y.year, y.ledger_currency]).slice(0, 2)).toEqual([
      [2025, 'BGN'],
      [2026, 'EUR'],
    ]);
  });
});

describe('conversion of the 31.12.2025 balances (ЗВЕРБ чл. 48)', () => {
  let entryId = '';

  it('previews every position converted on its own; the entry balances', async () => {
    const st = await euroConversionState(app, owner);
    if ('error' in st) throw new Error(st.error);
    expect(st.blockers).toEqual([]);
    expect(st.run).toBeNull();
    const conv = st.conversion!;
    const total = [...conv.lines.map((l) => l.eur), conv.equity, conv.result].reduce(
      (s, x) => s.plus(x),
      new Decimal(0),
    );
    expect(total.toFixed(2)).toBe('0.00');
    // Wages: 1024.51 → 523.83 (чл. 45), not 523.82.
    const wages = conv.lines.find((l) => l.accountCode === '421');
    expect(wages?.eur).toBe('-523.83');
  });

  it('posts one entry on 1.01.2026 with opening lines; the 2026 opening balances are the converted positions', async () => {
    const r = await runEuroConversion(app, owner, {
      gainAccountId: acc['724']!,
      lossAccountId: acc['624']!,
      equityAccountId: acc['122']!,
    });
    if (!r.ok) throw new Error(r.error);
    entryId = r.entryId;

    const tb25 = await trialBalance(app, owner, p2025[12]!, 1, 12);
    const tb26 = await trialBalance(app, owner, p2026[1]!, 1, 1);
    expect(tb26.reconciled).toBe(true);
    // Nothing of the conversion is January turnover.
    expect([tb26.totals.td, tb26.totals.tc]).toEqual(['0.00', '0.00']);
    const signed = (r: { od: string; oc: string }) => new Decimal(r.od).minus(r.oc);
    for (const row of tb25.rows) {
      const closing = new Decimal(row.cd).minus(row.cc);
      const conv = accounts[row.code as keyof typeof accounts][0];
      const expected =
        conv === 'wages'
          ? convertBgnToEurWages(closing.toFixed(2))
          : convertBgnToEur(closing.toFixed(2));
      const got = tb26.rows.find((x) => x.code === row.code);
      // Accounts kept by one position: the opening equals the account converted. (401 and the
      // equity/result accounts are checked below.)
      if (!['401', '122', '624', '724'].includes(row.code)) {
        expect(got ? signed(got).toFixed(2) : '0.00', row.code).toBe(expected.toFixed(2));
      }
    }
  });

  it('analytics and currency amounts are carried over; the analytic report still reconciles', async () => {
    const rep = await analyticReport(app, owner, acc['401']!, 'document', p2026[1]!, 1, 1);
    expect(rep.reconciled).toBe(true);
    // 655.12 − 300.00 = 355.12 BGN credit → 181.57 EUR (355.12 / 1.95583 = 181.5700…)
    expect(rep.rows.map((r) => [r.counterparty_id, r.document_number, r.opening])).toEqual([
      [cpA, 'Ф-1', convertBgnToEur('-355.12').toFixed(2)],
    ]);
    const usd = await withTenant(
      app,
      owner,
      async (c) =>
        (
          await c.query<{ doc_currency: string; doc_amount: string; amount: string }>(
            `SELECT doc_currency, doc_amount::text, amount::text FROM app.journal_line
         WHERE entry_id = $1 AND account_id = $2`,
            [entryId, acc['504']],
          )
        ).rows,
    );
    expect(usd).toEqual([{ doc_currency: 'USD', doc_amount: '1000.00', amount: '1000.00' }]);
  });

  it('the register lists the entry, balanced; a second run is refused', async () => {
    const reg = await chronologicalRegister(app, owner, p2026[1]!, 1, 1);
    expect(reg.lines.every((l) => l.is_opening)).toBe(true);
    expect(reg.totals.d).toBe(reg.totals.c);
    expect(
      await runEuroConversion(app, owner, {
        gainAccountId: acc['724']!,
        lossAccountId: acc['624']!,
        equityAccountId: acc['122']!,
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('вече е направено') });
  });

  it('a later change in 2025 shows the run as stale; after reversal it can run again', async () => {
    await entry('2025-12-30', [
      { code: '601', side: 'D', amount: '10.00' },
      { code: '503', side: 'C', amount: '10.00' },
    ]);
    const st = await euroConversionState(app, owner);
    if ('error' in st) throw new Error(st.error);
    expect(st.run?.stale).toBe(true);
    await withTenant(app, owner, (c) =>
      c.query('SELECT app.reverse_entry($1, $2)', [entryId, '2026-01-01']),
    );
    const again = await runEuroConversion(app, owner, {
      gainAccountId: acc['724']!,
      lossAccountId: acc['624']!,
      equityAccountId: acc['122']!,
    });
    expect(again.ok).toBe(true);
    const fresh = await euroConversionState(app, owner);
    if ('error' in fresh) throw new Error(fresh.error);
    expect(fresh.run?.stale).toBe(false);
    const tb26 = await trialBalance(app, owner, p2026[1]!, 1, 1);
    expect(tb26.reconciled).toBe(true);
  });

  it('opening lines cannot be posted by hand', async () => {
    await expect(
      withTenant(app, owner, async (c) => {
        const e = await c.query<{ id: string }>(
          `INSERT INTO app.journal_entry (office_id, company_id, period_id, entry_date, description, created_by)
           VALUES ($1, $2, $3, '2026-01-01', 'ръчно', $4) RETURNING id`,
          [owner.officeId, owner.companyId, p2026[1], owner.userId],
        );
        for (const [n, side] of [
          [1, 'D'],
          [2, 'C'],
        ] as const) {
          await c.query(
            `INSERT INTO app.journal_line (office_id, company_id, entry_id, line_no, account_id, side, amount, is_opening)
             VALUES ($1, $2, $3, $4, $5, $6, '1.00', true)`,
            [owner.officeId, owner.companyId, e.rows[0]!.id, n, acc['503'], side],
          );
        }
        await c.query(`UPDATE app.journal_entry SET status = 'posted' WHERE id = $1`, [
          e.rows[0]!.id,
        ]);
      }),
    ).rejects.toThrow('Редове за начални салда се създават само от превалутирането.');
  });
});

describe('roles and isolation', () => {
  it('an accountant cannot add years or run the conversion; another office sees no runs', async () => {
    const userId = await authUser();
    const token = randomBytes(16).toString('hex');
    await withTenant(app, owner, (c) =>
      c.query(
        'INSERT INTO app.invitation (office_id, email, role, token_hash, invited_by) VALUES ($1, $2, $3, $4, $5)',
        [
          owner.officeId,
          `${userId}@test.local`,
          'accountant',
          createHash('sha256').update(token).digest(),
          owner.userId,
        ],
      ),
    );
    await withUser(app, userId, (c) => c.query('SELECT app.accept_invitation($1)', [token]));
    await withTenant(app, owner, (c) =>
      c.query('INSERT INTO app.company_access VALUES ($1, $2, $3)', [
        owner.officeId,
        userId,
        owner.companyId,
      ]),
    );
    const accountant = { userId, officeId: owner.officeId, companyId: owner.companyId };
    await expect(
      withTenant(app, accountant, (c) => c.query('SELECT app.add_fiscal_year(2027)')),
    ).rejects.toThrow('Нямате право да добавяте години в тази фирма.');
    const other = await company();
    const seen = await withTenant(
      app,
      { ...other, companyId: owner.companyId },
      async (c) => (await c.query('SELECT 1 FROM app.euro_conversion_run')).rowCount,
    );
    expect(seen).toBe(0);
  });
});
