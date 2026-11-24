/**
 * Foreign-currency positions and their revaluation, enforced and reconciled in the
 * DATABASE (migration 20261125100000, ADR-0015). Rates are fixed test values, not
 * published rates; account codes are illustrative, not a prescribed chart.
 */
import { convertWithBnbRate } from '@kantora/domain';
import Decimal from 'decimal.js';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyticReport } from './analytic-reports';
import { trialBalance } from './reports';
import { fxPositions, runFxRevaluation, type FxConverter } from './revaluation';
import { withTenant, withUser, type TenantContext } from './tenant';

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const YEAR = new Date().getFullYear();
const day = (m: number, d: number) =>
  `${YEAR}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Test converter: per-euro quotes (the 2026+ form), half-up to the cent. */
const fixed = (rates: Record<string, string>): FxConverter => ({
  convert: (c, a) => {
    const rate = rates[c];
    if (!rate) throw new Error(`no test rate for ${c}`);
    return convertWithBnbRate(a, { kind: 'per_eur', rate }).toFixed(2);
  },
  rate: (c) => rates[c] ?? null,
});

type Ctx = TenantContext & { companyId: string };
let owner: Ctx;
const acc: Record<string, string> = {};
const periods: Record<number, string> = {};
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
      (await c.query<{ id: string }>(`SELECT app.register_office('Валути') AS id`)).rows[0]!.id,
  );
  const companyId = await withTenant(
    app,
    { userId, officeId },
    async (c) =>
      (await c.query<{ id: string }>(`SELECT app.create_company('Валути ООД') AS id`)).rows[0]!.id,
  );
  return { userId, officeId, companyId };
}

type Line = {
  code: string;
  side: 'D' | 'C';
  amount: string;
  cur?: [string, string];
  cp?: string;
  doc?: string;
};

async function entry(date: string, lines: Line[], ctx: Ctx = owner): Promise<string> {
  const month = Number(date.slice(5, 7));
  return withTenant(app, ctx, async (c) => {
    const e = await c.query<{ id: string }>(
      `INSERT INTO app.journal_entry (office_id, company_id, period_id, entry_date, description, created_by)
       VALUES ($1, $2, $3, $4, 'тест', $5) RETURNING id`,
      [owner.officeId, owner.companyId, periods[month], date, ctx.userId],
    );
    const id = e.rows[0]!.id;
    let n = 0;
    for (const l of lines) {
      await c.query(
        `INSERT INTO app.journal_line (office_id, company_id, entry_id, line_no, account_id, side, amount,
                                       doc_currency, doc_amount, counterparty_id, document_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          owner.officeId,
          owner.companyId,
          id,
          ++n,
          acc[l.code],
          l.side,
          l.amount,
          l.cur?.[0] ?? null,
          l.cur?.[1] ?? null,
          l.cp ?? null,
          l.doc ?? null,
        ],
      );
    }
    await c.query(`UPDATE app.journal_entry SET status = 'posted' WHERE id = $1`, [id]);
    return id;
  });
}

const run = (month: number, rates: Record<string, string>, ctx: Ctx = owner) =>
  runFxRevaluation(
    app,
    ctx,
    { periodId: periods[month]!, gainAccountId: acc['724']!, lossAccountId: acc['624']! },
    fixed(rates),
  );

/** Every position at the end of `month` equals its value at `rates`. */
async function expectRevalued(month: number, rates: Record<string, string>) {
  const read = await fxPositions(app, owner, periods[month]!);
  const fx = fixed(rates);
  for (const p of read!.positions) {
    const cur = new Decimal(p.currencyBalance);
    const v = cur.isZero()
      ? new Decimal(0)
      : new Decimal(fx.convert(p.currency, cur.abs().toFixed(2)));
    expect(new Decimal(p.ledgerBalance).toFixed(2), `${p.accountCode} ${p.currency}`).toBe(
      (cur.isNegative() ? v.negated() : v).toFixed(2),
    );
  }
}

beforeAll(async () => {
  owner = await company();
  await withTenant(app, owner, async (c) => {
    for (const [code, isCurrency, needs] of [
      ['504', true, false],
      ['401', true, true],
      ['601', false, false],
      ['702', false, false],
      ['624', false, false],
      ['724', false, false],
    ] as const) {
      const r = await c.query<{ id: string }>(
        `INSERT INTO app.account (office_id, company_id, code, name, is_currency, needs_counterparty, needs_document)
         VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
        [owner.officeId, owner.companyId, code, `Сметка ${code}`, isCurrency, needs],
      );
      acc[code] = r.rows[0]!.id;
    }
    for (const r of (
      await c.query<{ id: string; month: number }>('SELECT id, month FROM app.period')
    ).rows) {
      periods[r.month] = r.id;
    }
    cpA = (
      await c.query<{ id: string }>(
        `INSERT INTO app.counterparty (office_id, company_id, name) VALUES ($1, $2, 'Foreign Ltd') RETURNING id`,
        [owner.officeId, owner.companyId],
      )
    ).rows[0]!.id;
  });
});

describe('currency accounts', () => {
  it('a line on a currency account needs a foreign currency and a positive amount in it', async () => {
    await expect(
      entry(day(2, 3), [
        { code: '504', side: 'D', amount: '10.00' },
        { code: '702', side: 'C', amount: '10.00' },
      ]),
    ).rejects.toThrow('Ред 1: сметка 504 е валутна: въведете валута и сума във валута.');
    await expect(
      entry(day(2, 3), [
        { code: '504', side: 'D', amount: '10.00', cur: ['EUR', '10.00'] },
        { code: '702', side: 'C', amount: '10.00' },
      ]),
    ).rejects.toThrow('Ред 1: EUR е отчетната валута на годината');
    await expect(
      entry(day(2, 3), [
        { code: '504', side: 'D', amount: '10.00', cur: ['USD', '0'] },
        { code: '702', side: 'C', amount: '10.00' },
      ]),
    ).rejects.toThrow('Ред 1: сумата във валута по сметка 504 трябва да е положителна.');
  });
});

describe('revaluation at the closing rate', () => {
  it('posts the differences per position, gross gain and loss, dated the last day', async () => {
    // A supplier invoice of 1000 USD at 1.1000 and 2000 USD received at 1.1000.
    await entry(day(3, 10), [
      { code: '601', side: 'D', amount: '909.09' },
      { code: '401', side: 'C', amount: '909.09', cur: ['USD', '1000.00'], cp: cpA, doc: 'INV-1' },
    ]);
    await entry(day(4, 2), [
      { code: '504', side: 'D', amount: '1818.18', cur: ['USD', '2000.00'] },
      { code: '702', side: 'C', amount: '1818.18' },
    ]);
    const r = await run(4, { USD: '1.2000' });
    if (!r.ok) throw new Error(r.error);
    // 401: −1000 USD → −833.33 (was −909.09): +75.76. 504: 2000 USD → 1666.67 (was 1818.18): −151.51.
    expect(r.revaluation.lines.map((l) => [l.position.accountCode, l.side, l.amount])).toEqual([
      ['401', 'D', '75.76'],
      ['504', 'C', '151.51'],
    ]);
    expect([r.revaluation.gain, r.revaluation.loss]).toEqual(['75.76', '151.51']);
    const lines = await withTenant(
      app,
      owner,
      async (c) =>
        (
          await c.query<{
            code: string;
            side: string;
            amount: string;
            doc_currency: string | null;
            doc_amount: string | null;
            fx_rate: string | null;
            counterparty_id: string | null;
            document_number: string | null;
            entry_date: string;
          }>(
            `SELECT a.code, l.side, l.amount::text, l.doc_currency, l.doc_amount::text, l.fx_rate::text,
                    l.counterparty_id, l.document_number, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date
             FROM app.journal_line l JOIN app.account a ON a.id = l.account_id
             JOIN app.journal_entry e ON e.id = l.entry_id WHERE l.entry_id = $1 ORDER BY l.line_no`,
            [r.entryId],
          )
        ).rows,
    );
    expect(lines.map((l) => [l.code, l.side, l.amount])).toEqual([
      ['401', 'D', '75.76'],
      ['504', 'C', '151.51'],
      ['624', 'D', '151.51'],
      ['724', 'C', '75.76'],
    ]);
    expect(lines[0]).toMatchObject({
      doc_currency: 'USD',
      doc_amount: '0.00',
      counterparty_id: cpA,
      document_number: 'INV-1',
      entry_date: day(4, 30),
    });
    expect(Number(lines[0]!.fx_rate)).toBe(1.2);
    await expectRevalued(4, { USD: '1.2000' });
  });

  it('a second run at the same rates has nothing to post', async () => {
    expect(await run(4, { USD: '1.2000' })).toEqual({
      ok: false,
      error: 'Няма разлики за осчетоводяване: позициите вече са по заключителния курс.',
    });
  });

  it('after a partial settlement the next month brings every position to its rate', async () => {
    // Pay 500 USD of INV-1 at 1.2500 (400.00 EUR) from the USD account.
    await entry(day(5, 15), [
      { code: '401', side: 'D', amount: '400.00', cur: ['USD', '500.00'], cp: cpA, doc: 'INV-1' },
      { code: '504', side: 'C', amount: '400.00', cur: ['USD', '500.00'] },
    ]);
    const r = await run(5, { USD: '1.2500' });
    expect(r.ok).toBe(true);
    await expectRevalued(5, { USD: '1.2500' });
  });

  it('the analytic report and the trial balance still reconcile', async () => {
    const tb = await trialBalance(app, owner, periods[5]!, 1, 5);
    expect(tb.reconciled).toBe(true);
    const rep = await analyticReport(app, owner, acc['401']!, 'document', periods[5]!, 1, 5);
    expect(rep.reconciled).toBe(true);
    // −500 USD left on INV-1 at 1.2500 = −400.00.
    expect(rep.rows.map((x) => [x.document_number, x.closing])).toEqual([['INV-1', '-400.00']]);
  });

  it('a locked period refuses it; the run entry can be reversed like any entry', async () => {
    await withTenant(app, owner, (c) =>
      c.query('UPDATE app.period SET locked_at = now(), locked_by = $2 WHERE id = $1', [
        periods[6],
        owner.userId,
      ]),
    );
    expect(await run(6, { USD: '1.3000' })).toEqual({
      ok: false,
      error: 'Периодът е заключен: преоценка в него не може да се осчетоводи.',
    });
    await withTenant(app, owner, (c) =>
      c.query('UPDATE app.period SET locked_at = NULL, locked_by = NULL WHERE id = $1', [
        periods[6],
      ]),
    );
    const r = await run(6, { USD: '1.3000' });
    if (!r.ok) throw new Error(r.error);
    await withTenant(app, owner, (c) =>
      c.query('SELECT app.reverse_entry($1, $2)', [r.entryId, day(6, 30)]),
    );
    await expectRevalued(6, { USD: '1.2500' }); // back to the May values
  });

  it('a run must be dated the last day of its period and is never changed or deleted', async () => {
    const r = await withTenant(
      app,
      owner,
      async (c) =>
        (await c.query<{ id: string }>('SELECT id FROM app.fx_revaluation_run LIMIT 1')).rows[0]!
          .id,
    );
    await expect(
      withTenant(app, owner, (c) =>
        c.query(`UPDATE app.fx_revaluation_run SET rate_date = rate_date WHERE id = $1`, [r]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(app, owner, (c) =>
        c.query(`DELETE FROM app.fx_revaluation_run WHERE id = $1`, [r]),
      ),
    ).rejects.toThrow(/permission denied/);
    const e = await entry(day(7, 5), [
      { code: '601', side: 'D', amount: '1.00' },
      { code: '702', side: 'C', amount: '1.00' },
    ]);
    await expect(
      withTenant(app, owner, (c) =>
        c.query(
          `INSERT INTO app.fx_revaluation_run (office_id, company_id, period_id, rate_date, entry_id, gain_account_id, loss_account_id)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [owner.officeId, owner.companyId, periods[7], day(7, 5), e, acc['724']],
        ),
      ),
    ).rejects.toThrow('Преоценката е към последния ден на периода.');
  });
});

describe('roles and isolation', () => {
  async function member(role: string): Promise<Ctx> {
    const userId = await authUser();
    const token = randomBytes(16).toString('hex');
    await withTenant(app, owner, (c) =>
      c.query(
        'INSERT INTO app.invitation (office_id, email, role, token_hash, invited_by) VALUES ($1, $2, $3, $4, $5)',
        [
          owner.officeId,
          `${userId}@test.local`,
          role,
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
    return { userId, officeId: owner.officeId, companyId: owner.companyId };
  }

  it('read-only cannot run it; payroll and another office see no runs', async () => {
    const ro = await member('read_only');
    await expect(run(8, { USD: '1.4000' }, ro)).rejects.toThrow(/row-level security/);
    const trz = await member('payroll');
    const count = (ctx: Ctx) =>
      withTenant(
        app,
        ctx,
        async (c) => (await c.query('SELECT 1 FROM app.fx_revaluation_run')).rowCount,
      );
    expect(await count(trz)).toBe(0);
    const other = await company();
    expect(await count({ ...other, companyId: owner.companyId })).toBe(0);
    expect(await count(owner)).toBeGreaterThan(0);
  });
});
