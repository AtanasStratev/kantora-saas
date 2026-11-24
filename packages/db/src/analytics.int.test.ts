/**
 * Analytics enforced by the DATABASE (migration 20261124100000, ADR-0014): an account's
 * needs (counterparty, document, cost object) are checked when an entry is POSTED; drafts
 * may be incomplete; inactive counterparties/objects cannot be used on new lines but a
 * reversal mirrors its original; roles and tenant isolation of the new tables.
 */
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, withUser, type TenantContext } from './tenant';

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const YEAR = new Date().getFullYear();
const D1 = `${YEAR}-03-10`;

async function authUser(): Promise<string> {
  const id = randomUUID();
  await admin.query(
    'INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)',
    [id, 'Т', `${id}@test.local`],
  );
  return id;
}

type Ctx = TenantContext & { companyId: string };
type World = { owner: Ctx; acc: Record<string, string>; period: string };

async function setUpCompany(): Promise<World> {
  const userId = await authUser();
  const officeId = await withUser(
    app,
    userId,
    async (c) =>
      (await c.query<{ id: string }>(`SELECT app.register_office('Аналитики') AS id`)).rows[0]!.id,
  );
  const companyId = await withTenant(
    app,
    { userId, officeId },
    async (c) =>
      (await c.query<{ id: string }>(`SELECT app.create_company('Аналитики ЕООД') AS id`)).rows[0]!
        .id,
  );
  const owner = { userId, officeId, companyId };
  const acc: Record<string, string> = {};
  // Illustrative test accounts (the real chart comes from the pilot, phase 2 step 10).
  await withTenant(app, owner, async (c) => {
    for (const [code, cp, doc, obj] of [
      ['401', true, true, false],
      ['601', false, false, true],
      ['501', false, false, false],
    ] as const) {
      const r = await c.query<{ id: string }>(
        `INSERT INTO app.account (office_id, company_id, code, name, needs_counterparty, needs_document, needs_cost_object)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [officeId, companyId, code, `Сметка ${code}`, cp, doc, obj],
      );
      acc[code] = r.rows[0]!.id;
    }
  });
  const period = await withTenant(
    app,
    owner,
    async (c) =>
      (await c.query<{ id: string }>('SELECT id FROM app.period WHERE month = 3')).rows[0]!.id,
  );
  return { owner, acc, period };
}

type Line = {
  code: string;
  side: 'D' | 'C';
  amount: string;
  cp?: string | null;
  doc?: string | null;
  docDate?: string | null;
  obj?: string | null;
};

async function entry(w: World, lines: Line[], opts: { post?: boolean; ctx?: Ctx } = {}) {
  const ctx = opts.ctx ?? w.owner;
  return withTenant(app, ctx, async (c) => {
    const e = await c.query<{ id: string }>(
      `INSERT INTO app.journal_entry (office_id, company_id, period_id, entry_date, description, created_by)
       VALUES ($1, $2, $3, $4, 'тест', $5) RETURNING id`,
      [w.owner.officeId, w.owner.companyId, w.period, D1, ctx.userId],
    );
    const id = e.rows[0]!.id;
    let n = 0;
    for (const l of lines) {
      await c.query(
        `INSERT INTO app.journal_line (office_id, company_id, entry_id, line_no, account_id, side, amount,
                                       counterparty_id, document_number, document_date, cost_object_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          w.owner.officeId,
          w.owner.companyId,
          id,
          ++n,
          w.acc[l.code],
          l.side,
          l.amount,
          l.cp ?? null,
          l.doc ?? null,
          l.docDate ?? null,
          l.obj ?? null,
        ],
      );
    }
    if (opts.post !== false) {
      await c.query(`UPDATE app.journal_entry SET status = 'posted' WHERE id = $1`, [id]);
    }
    return id;
  });
}

async function counterparty(w: World, name: string, eik: string | null, ctx: Ctx = w.owner) {
  return withTenant(
    app,
    ctx,
    async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO app.counterparty (office_id, company_id, name, eik) VALUES ($1, $2, $3, $4) RETURNING id`,
          [w.owner.officeId, w.owner.companyId, name, eik],
        )
      ).rows[0]!.id,
  );
}

async function costObject(w: World, code: string, ctx: Ctx = w.owner) {
  return withTenant(
    app,
    ctx,
    async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO app.cost_object (office_id, company_id, code, name) VALUES ($1, $2, $3, $4) RETURNING id`,
          [w.owner.officeId, w.owner.companyId, code, `Обект ${code}`],
        )
      ).rows[0]!.id,
  );
}

async function member(w: World, role: string): Promise<Ctx> {
  const userId = await authUser();
  const token = randomBytes(16).toString('hex');
  await withTenant(app, w.owner, (c) =>
    c.query(
      'INSERT INTO app.invitation (office_id, email, role, token_hash, invited_by) VALUES ($1, $2, $3, $4, $5)',
      [
        w.owner.officeId,
        `${userId}@test.local`,
        role,
        createHash('sha256').update(token).digest(),
        w.owner.userId,
      ],
    ),
  );
  await withUser(app, userId, (c) => c.query('SELECT app.accept_invitation($1)', [token]));
  await withTenant(app, w.owner, (c) =>
    c.query('INSERT INTO app.company_access VALUES ($1, $2, $3)', [
      w.owner.officeId,
      userId,
      w.owner.companyId,
    ]),
  );
  return { userId, officeId: w.owner.officeId, companyId: w.owner.companyId };
}

let w: World;
let cp: string;
let obj: string;
beforeAll(async () => {
  w = await setUpCompany();
  cp = await counterparty(w, 'Доставчик ООД', '000000000');
  obj = await costObject(w, 'О1');
});

describe('analytics required by the account', () => {
  it('posting refuses a line without the counterparty, document or object its account needs', async () => {
    await expect(
      entry(w, [
        { code: '601', side: 'D', amount: '10.00', obj },
        { code: '401', side: 'C', amount: '10.00', doc: 'Ф-1' },
      ]),
    ).rejects.toThrow('Ред 2: сметка 401 изисква контрагент');
    await expect(
      entry(w, [
        { code: '601', side: 'D', amount: '10.00', obj },
        { code: '401', side: 'C', amount: '10.00', cp },
      ]),
    ).rejects.toThrow('Ред 2: сметка 401 изисква документ');
    await expect(
      entry(w, [
        { code: '601', side: 'D', amount: '10.00' },
        { code: '401', side: 'C', amount: '10.00', cp, doc: 'Ф-1' },
      ]),
    ).rejects.toThrow('Ред 1: сметка 601 изисква обект');
  });

  it('a complete entry posts; a draft may be incomplete; accounts without needs take none', async () => {
    const id = await entry(w, [
      { code: '601', side: 'D', amount: '10.00', obj },
      { code: '401', side: 'C', amount: '10.00', cp, doc: 'Ф-1', docDate: D1 },
    ]);
    const draft = await entry(
      w,
      [
        { code: '601', side: 'D', amount: '5.00' },
        { code: '401', side: 'C', amount: '5.00' },
      ],
      { post: false },
    );
    await entry(w, [
      { code: '501', side: 'D', amount: '1.00' },
      { code: '501', side: 'C', amount: '1.00' },
    ]);
    const rows = await withTenant(
      app,
      w.owner,
      async (c) =>
        (
          await c.query<{ id: string; status: string }>(
            'SELECT id, status FROM app.journal_entry WHERE id = ANY($1)',
            [[id, draft]],
          )
        ).rows,
    );
    expect(new Map(rows.map((r) => [r.id, r.status]))).toEqual(
      new Map([
        [id, 'posted'],
        [draft, 'draft'],
      ]),
    );
  });

  it('a document date needs a document number', async () => {
    await expect(
      entry(
        w,
        [
          { code: '501', side: 'D', amount: '1.00', docDate: D1 },
          { code: '501', side: 'C', amount: '1.00' },
        ],
        { post: false },
      ),
    ).rejects.toThrow(/journal_line_document_date_check/);
  });

  it('an inactive counterparty is refused on new lines, but a reversal still mirrors the original', async () => {
    const cp2 = await counterparty(w, 'Стар доставчик', null);
    const original = await entry(w, [
      { code: '601', side: 'D', amount: '20.00', obj },
      { code: '401', side: 'C', amount: '20.00', cp: cp2, doc: 'Ф-2' },
    ]);
    await withTenant(app, w.owner, (c) =>
      c.query('UPDATE app.counterparty SET is_active = false WHERE id = $1', [cp2]),
    );
    await expect(
      entry(w, [
        { code: '601', side: 'D', amount: '1.00', obj },
        { code: '401', side: 'C', amount: '1.00', cp: cp2, doc: 'Ф-3' },
      ]),
    ).rejects.toThrow('Контрагентът е неактивен.');

    // The account's needs change after posting: the reversal is not re-checked.
    await withTenant(app, w.owner, (c) =>
      c.query('UPDATE app.account SET needs_cost_object = true WHERE id = $1', [w.acc['401']]),
    );
    const rev = await withTenant(
      app,
      w.owner,
      async (c) =>
        (await c.query<{ id: string }>('SELECT app.reverse_entry($1, $2) AS id', [original, D1]))
          .rows[0]!.id,
    );
    await withTenant(app, w.owner, (c) =>
      c.query('UPDATE app.account SET needs_cost_object = false WHERE id = $1', [w.acc['401']]),
    );
    const lines = await withTenant(
      app,
      w.owner,
      async (c) =>
        (
          await c.query<{
            side: string;
            counterparty_id: string | null;
            document_number: string | null;
            cost_object_id: string | null;
          }>(
            'SELECT side, counterparty_id, document_number, cost_object_id FROM app.journal_line WHERE entry_id = $1 ORDER BY line_no',
            [rev],
          )
        ).rows,
    );
    expect(lines).toEqual([
      { side: 'C', counterparty_id: null, document_number: null, cost_object_id: obj },
      { side: 'D', counterparty_id: cp2, document_number: 'Ф-2', cost_object_id: null },
    ]);
  });

  it('EIK: 9 or 13 digits, one counterparty per EIK in a company; VAT number shape', async () => {
    await expect(counterparty(w, 'Кратък', '12345')).rejects.toThrow(/counterparty_eik_check/);
    await expect(counterparty(w, 'Двойник', '000000000')).rejects.toThrow(
      /counterparty_company_eik_key/,
    );
    await counterparty(w, 'Клон', '0000000000001');
    await expect(
      withTenant(app, w.owner, (c) =>
        c.query(
          `INSERT INTO app.counterparty (office_id, company_id, name, vat_number) VALUES ($1, $2, 'X', 'bg123')`,
          [w.owner.officeId, w.owner.companyId],
        ),
      ),
    ).rejects.toThrow(/counterparty_vat_number_check/);
  });
});

describe('roles and isolation', () => {
  it('accountant creates counterparties but not cost objects; read-only reads; payroll sees nothing', async () => {
    const acc = await member(w, 'accountant');
    await counterparty(w, 'От счетоводител', null, acc);
    await expect(costObject(w, 'О9', acc)).rejects.toThrow(/row-level security/);

    const ro = await member(w, 'read_only');
    const roSees = await withTenant(
      app,
      ro,
      async (c) => (await c.query('SELECT 1 FROM app.counterparty')).rowCount,
    );
    expect(roSees).toBeGreaterThan(0);
    await expect(counterparty(w, 'От четящ', null, ro)).rejects.toThrow(/row-level security/);

    const trz = await member(w, 'payroll');
    const trzSees = await withTenant(app, trz, async (c) => {
      const a = (await c.query('SELECT 1 FROM app.counterparty')).rowCount;
      const b = (await c.query('SELECT 1 FROM app.cost_object')).rowCount;
      return (a ?? 0) + (b ?? 0);
    });
    expect(trzSees).toBe(0);
  });

  it('nobody deletes a counterparty (deactivate instead)', async () => {
    await expect(
      withTenant(app, w.owner, (c) => c.query('DELETE FROM app.counterparty WHERE id = $1', [cp])),
    ).rejects.toThrow(/permission denied/);
  });

  it('another office sees nothing and cannot use this company’s counterparty', async () => {
    const other = await setUpCompany();
    const seen = await withTenant(
      app,
      { userId: other.owner.userId, officeId: other.owner.officeId, companyId: w.owner.companyId },
      async (c) => {
        const a = (await c.query('SELECT 1 FROM app.counterparty')).rowCount;
        const b = (await c.query('SELECT 1 FROM app.cost_object')).rowCount;
        return (a ?? 0) + (b ?? 0);
      },
    );
    expect(seen).toBe(0);
    // A line of the other company pointing at our counterparty violates the tenant FK.
    await expect(
      entry(
        other,
        [
          { code: '501', side: 'D', amount: '1.00', cp },
          { code: '501', side: 'C', amount: '1.00' },
        ],
        { post: false },
      ),
    ).rejects.toThrow(/journal_line_counterparty_fk/);
  });

  it('every change to counterparties and objects is audited', async () => {
    const n = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM app.audit_log WHERE table_name IN ('counterparty', 'cost_object') AND company_id = $1`,
      [w.owner.companyId],
    );
    expect(Number(n.rows[0]!.n)).toBeGreaterThanOrEqual(3);
  });
});
