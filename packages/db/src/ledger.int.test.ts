/**
 * Ledger integrity enforced by the DATABASE (PROMPT.md 3.3), not just the UI:
 * Dt = Кт on posting, immutable posted entries, reversal, locked periods (no exceptions,
 * not even for system jobs), entry date inside its period, postable accounts only, roles,
 * and the trial balance reconciling with the journal.
 */
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { trialBalance, type PostedLine } from '@kantora/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, withUser, type TenantContext } from './tenant';

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const YEAR = new Date().getFullYear();
const NOV = `${YEAR}-11`;

async function authUser(): Promise<string> {
  const id = randomUUID();
  await admin.query(
    'INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)',
    [id, 'Т', `${id}@test.local`],
  );
  return id;
}

type World = {
  owner: TenantContext & { companyId: string };
  acc: Record<string, string>; // code -> account id
  periods: Record<number, string>; // month -> period id
};

async function setUpCompany(): Promise<World> {
  const userId = await authUser();
  const officeId = await withUser(
    app,
    userId,
    async (c) =>
      (await c.query<{ id: string }>(`SELECT app.register_office('Счетоводство') AS id`)).rows[0]!
        .id,
  );
  const companyId = await withTenant(
    app,
    { userId, officeId },
    async (c) =>
      (await c.query<{ id: string }>(`SELECT app.create_company('Тест ЕООД') AS id`)).rows[0]!.id,
  );
  const owner = { userId, officeId, companyId };
  // Illustrative test accounts only (the real chart comes from the pilot, phase 2 step 10).
  const acc: Record<string, string> = {};
  await withTenant(app, owner, async (c) => {
    for (const [code, name, postable] of [
      ['60', 'Група разходи', false],
      ['501', 'Каса', true],
      ['401', 'Доставчици', true],
      ['601', 'Разходи за материали', true],
      ['702', 'Приходи от услуги', true],
    ] as const) {
      const r = await c.query<{ id: string }>(
        'INSERT INTO app.account (office_id, company_id, code, name, is_postable) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [officeId, companyId, code, name, postable],
      );
      acc[code] = r.rows[0]!.id;
    }
  });
  const periods: Record<number, string> = {};
  await withTenant(app, owner, async (c) => {
    for (const r of (
      await c.query<{ id: string; month: number }>('SELECT id, month FROM app.period')
    ).rows) {
      periods[r.month] = r.id;
    }
  });
  return { owner, acc, periods };
}

type Line = [code: string, side: 'D' | 'C', amount: string];

/** Draft + lines (+ post) in ONE transaction, as the app does. Returns the entry id. */
async function entry(
  w: World,
  date: string,
  lines: Line[],
  opts: { post?: boolean; ctx?: TenantContext } = {},
): Promise<string> {
  const ctx = opts.ctx ?? w.owner;
  const month = Number(date.slice(5, 7));
  return withTenant(app, ctx, async (c) => {
    const e = await c.query<{ id: string }>(
      `INSERT INTO app.journal_entry (office_id, company_id, period_id, entry_date, description, created_by)
       VALUES ($1, $2, $3, $4, 'тест', $5) RETURNING id`,
      [w.owner.officeId, w.owner.companyId, w.periods[month], date, ctx.userId],
    );
    const id = e.rows[0]!.id;
    let n = 0;
    for (const [code, side, amount] of lines) {
      await c.query(
        `INSERT INTO app.journal_line (office_id, company_id, entry_id, line_no, account_id, side, amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [w.owner.officeId, w.owner.companyId, id, ++n, w.acc[code], side, amount],
      );
    }
    if (opts.post !== false) {
      await c.query(`UPDATE app.journal_entry SET status = 'posted' WHERE id = $1`, [id]);
    }
    return id;
  });
}

const q = <T extends pg.QueryResultRow>(w: World, sql: string, params: unknown[] = []) =>
  withTenant(app, w.owner, async (c) => (await c.query<T>(sql, params)).rows);

let w: World;
beforeAll(async () => {
  w = await setUpCompany();
});

describe('posting', () => {
  it('a balanced entry posts and gets the next number in the year', async () => {
    const a = await entry(w, `${NOV}-03`, [
      ['601', 'D', '100.00'],
      ['401', 'C', '100.00'],
    ]);
    const b = await entry(w, `${NOV}-04`, [
      ['501', 'D', '50.00'],
      ['702', 'C', '50.00'],
    ]);
    const rows = await q<{ id: string; number: number; status: string }>(
      w,
      'SELECT id, number, status FROM app.journal_entry WHERE id = ANY($1) ORDER BY number',
      [[a, b]],
    );
    expect(rows.map((r) => r.status)).toEqual(['posted', 'posted']);
    expect(rows[1]!.number).toBe(rows[0]!.number + 1);
  });

  it('an unbalanced entry is refused at commit — nothing is saved', async () => {
    const before = await q<{ n: number }>(w, 'SELECT count(*)::int AS n FROM app.journal_entry');
    await expect(
      entry(w, `${NOV}-05`, [
        ['601', 'D', '120.00'],
        ['401', 'C', '100.00'],
      ]),
    ).rejects.toThrow(/не е равен на кредита/);
    const after = await q<{ n: number }>(w, 'SELECT count(*)::int AS n FROM app.journal_entry');
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('a one-sided or single-line entry cannot be posted', async () => {
    await expect(entry(w, `${NOV}-05`, [['601', 'D', '10.00']])).rejects.toThrow(/поне един ред/);
  });

  it('a draft may be unbalanced while it is being entered, and may be deleted', async () => {
    const id = await entry(w, `${NOV}-06`, [['601', 'D', '1.00']], { post: false });
    await withTenant(app, w.owner, (c) =>
      c.query('DELETE FROM app.journal_entry WHERE id = $1', [id]),
    );
    expect(await q(w, 'SELECT 1 FROM app.journal_entry WHERE id = $1', [id])).toEqual([]);
  });

  it('entry date outside its period, group accounts and zero amounts are refused', async () => {
    await expect(
      withTenant(app, w.owner, (c) =>
        c.query(
          `INSERT INTO app.journal_entry (office_id, company_id, period_id, entry_date, created_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [w.owner.officeId, w.owner.companyId, w.periods[11], `${YEAR}-12-01`, w.owner.userId],
        ),
      ),
    ).rejects.toThrow(/извън периода/);
    await expect(
      entry(w, `${NOV}-07`, [
        ['60', 'D', '5.00'],
        ['401', 'C', '5.00'],
      ]),
    ).rejects.toThrow(/групова/);
    await expect(
      entry(w, `${NOV}-07`, [
        ['601', 'D', '0.00'],
        ['401', 'C', '0.00'],
      ]),
    ).rejects.toThrow(/journal_line_amount_check/);
  });

  it('an entry cannot be created directly as posted', async () => {
    await expect(
      withTenant(app, w.owner, (c) =>
        c.query(
          `INSERT INTO app.journal_entry (office_id, company_id, period_id, entry_date, status, created_by)
           VALUES ($1, $2, $3, $4, 'posted', $5)`,
          [w.owner.officeId, w.owner.companyId, w.periods[11], `${NOV}-08`, w.owner.userId],
        ),
      ),
    ).rejects.toThrow(/чернова/);
  });
});

describe('posted entries are immutable; corrections by reversal', () => {
  it('no update, delete or line change on a posted entry', async () => {
    const id = await entry(w, `${NOV}-10`, [
      ['601', 'D', '30.00'],
      ['401', 'C', '30.00'],
    ]);
    const run = (sql: string, p: unknown[]) => withTenant(app, w.owner, (c) => c.query(sql, p));
    await expect(
      run(`UPDATE app.journal_entry SET description = 'x' WHERE id = $1`, [id]),
    ).rejects.toThrow(/не се променя/);
    await expect(run('DELETE FROM app.journal_entry WHERE id = $1', [id])).rejects.toThrow(
      /не се изтрива/,
    );
    await expect(
      run(`UPDATE app.journal_line SET amount = 31 WHERE entry_id = $1`, [id]),
    ).rejects.toThrow(/не се променя/);
    await expect(run('DELETE FROM app.journal_line WHERE entry_id = $1', [id])).rejects.toThrow(
      /не се променя/,
    );
  });

  it('the schema owner is bound by the same rules (triggers have no exceptions)', async () => {
    const id = await entry(w, `${NOV}-11`, [
      ['601', 'D', '7.00'],
      ['401', 'C', '7.00'],
    ]);
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.system_actor', 'test', true)`);
      await expect(c.query('DELETE FROM app.journal_entry WHERE id = $1', [id])).rejects.toThrow(
        /не се изтрива/,
      );
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('reversal swaps sides, nets to zero, and can happen only once', async () => {
    const id = await entry(w, `${NOV}-12`, [
      ['601', 'D', '83.33'],
      ['501', 'D', '16.67'],
      ['401', 'C', '100.00'],
    ]);
    const rev = await withTenant(
      app,
      w.owner,
      async (c) =>
        (await c.query<{ id: string }>(`SELECT app.reverse_entry($1, $2) AS id`, [id, `${NOV}-20`]))
          .rows[0]!.id,
    );
    const net = await q<{ code: string; net: string }>(
      w,
      `SELECT a.code, sum(CASE l.side WHEN 'D' THEN l.amount ELSE -l.amount END)::text AS net
       FROM app.journal_line l JOIN app.account a ON a.id = l.account_id
       WHERE l.entry_id IN ($1, $2) GROUP BY a.code ORDER BY a.code`,
      [id, rev],
    );
    expect(net.every((r) => Number(r.net) === 0)).toBe(true);
    await expect(
      withTenant(app, w.owner, (c) =>
        c.query('SELECT app.reverse_entry($1, $2)', [id, `${NOV}-21`]),
      ),
    ).rejects.toThrow(/вече е сторнирана/);
    await expect(
      withTenant(app, w.owner, (c) =>
        c.query('SELECT app.reverse_entry($1, $2)', [rev, `${NOV}-21`]),
      ),
    ).rejects.toThrow(/вече е сторно/);
  });
});

describe('locked periods accept nothing', () => {
  it('blocks new entries, posting drafts and reversals into the period; unlocking restores', async () => {
    const draft = await entry(
      w,
      `${YEAR}-10-05`,
      [
        ['601', 'D', '9.00'],
        ['401', 'C', '9.00'],
      ],
      { post: false },
    );
    const posted = await entry(w, `${YEAR}-09-05`, [
      ['601', 'D', '4.00'],
      ['401', 'C', '4.00'],
    ]);
    const lock = (month: number, on: boolean) =>
      withTenant(app, w.owner, (c) =>
        c.query(
          on
            ? 'UPDATE app.period SET locked_at = now(), locked_by = $2 WHERE id = $1'
            : 'UPDATE app.period SET locked_at = NULL, locked_by = NULL WHERE id = $1',
          on ? [w.periods[month], w.owner.userId] : [w.periods[month]],
        ),
      );
    await lock(10, true);
    await expect(
      entry(w, `${YEAR}-10-06`, [
        ['601', 'D', '1.00'],
        ['401', 'C', '1.00'],
      ]),
    ).rejects.toThrow(/заключен/);
    await expect(
      withTenant(app, w.owner, (c) =>
        c.query(`UPDATE app.journal_entry SET status = 'posted' WHERE id = $1`, [draft]),
      ),
    ).rejects.toThrow(/заключен/);
    await expect(
      withTenant(app, w.owner, (c) =>
        c.query('SELECT app.reverse_entry($1, $2)', [posted, `${YEAR}-10-07`]),
      ),
    ).rejects.toThrow(/заключен/);

    // Even a background job (system actor, schema owner connection) is refused.
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.system_actor', 'import-job', true)`);
      await expect(
        c.query(
          `INSERT INTO app.journal_entry (office_id, company_id, period_id, entry_date, created_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [w.owner.officeId, w.owner.companyId, w.periods[10], `${YEAR}-10-08`, w.owner.userId],
        ),
      ).rejects.toThrow(/заключен/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }

    await lock(10, false);
    await withTenant(app, w.owner, (c) =>
      c.query(`UPDATE app.journal_entry SET status = 'posted' WHERE id = $1`, [draft]),
    );
    const st = await q<{ status: string }>(
      w,
      'SELECT status FROM app.journal_entry WHERE id = $1',
      [draft],
    );
    expect(st[0]!.status).toBe('posted');
  });
});

describe('roles and isolation', () => {
  async function member(role: string): Promise<TenantContext & { companyId: string }> {
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

  it('accountant posts; read-only reads but cannot post; payroll sees no general ledger', async () => {
    const acc = await member('accountant');
    await entry(
      w,
      `${NOV}-14`,
      [
        ['601', 'D', '2.00'],
        ['401', 'C', '2.00'],
      ],
      { ctx: acc },
    );

    const ro = await member('read_only');
    const seen = await withTenant(
      app,
      ro,
      async (c) => (await c.query('SELECT 1 FROM app.journal_line')).rowCount,
    );
    expect(seen).toBeGreaterThan(0);
    await expect(
      entry(
        w,
        `${NOV}-14`,
        [
          ['601', 'D', '2.00'],
          ['401', 'C', '2.00'],
        ],
        { ctx: ro },
      ),
    ).rejects.toThrow(/row-level security/);

    const trz = await member('payroll');
    const trzSees = await withTenant(
      app,
      trz,
      async (c) => (await c.query('SELECT 1 FROM app.journal_line')).rowCount,
    );
    expect(trzSees).toBe(0);
  });

  it('another office sees nothing of this ledger', async () => {
    const other = await setUpCompany();
    const seen = await withTenant(
      app,
      { userId: other.owner.userId, officeId: other.owner.officeId, companyId: w.owner.companyId },
      async (c) => (await c.query('SELECT 1 FROM app.journal_entry')).rowCount,
    );
    expect(seen).toBe(0);
  });
});

describe('reconciliation: trial balance = journal (PROMPT.md 3.3)', () => {
  it('the domain trial balance and SQL sums agree on 200 generated entries', async () => {
    const r = await setUpCompany();
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const codes = ['501', '401', '601', '702'];
    for (let i = 0; i < 200; i++) {
      const cents = Math.floor(rnd() * 500_000) + 1;
      const amount = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
      const month = Math.floor(rnd() * 12) + 1;
      const date = `${YEAR}-${String(month).padStart(2, '0')}-${String(Math.floor(rnd() * 28) + 1).padStart(2, '0')}`;
      const d = codes[Math.floor(rnd() * 4)]!;
      const c = codes[(codes.indexOf(d) + 1 + Math.floor(rnd() * 3)) % 4]!;
      await entry(r, date, [
        [d, 'D', amount],
        [c, 'C', amount],
      ]);
    }
    const rows = await q<{ code: string; side: 'D' | 'C'; amount: string; date: string }>(
      r,
      `SELECT a.code, l.side, l.amount::text AS amount, to_char(e.entry_date, 'YYYY-MM-DD') AS date
       FROM app.journal_line l JOIN app.journal_entry e ON e.id = l.entry_id
       JOIN app.account a ON a.id = l.account_id WHERE e.status = 'posted'`,
    );
    const lines: PostedLine[] = rows.map((x) => ({
      accountCode: x.code,
      side: x.side,
      amount: x.amount,
      date: x.date,
    }));
    const tb = trialBalance(lines, `${YEAR}-04-01`, `${YEAR}-06-30`);
    const sql = await q<{ code: string; td: string; tc: string }>(
      r,
      `SELECT a.code, coalesce(sum(l.amount) FILTER (WHERE l.side = 'D'), 0)::numeric(19,2)::text AS td,
              coalesce(sum(l.amount) FILTER (WHERE l.side = 'C'), 0)::numeric(19,2)::text AS tc
       FROM app.journal_line l JOIN app.journal_entry e ON e.id = l.entry_id
       JOIN app.account a ON a.id = l.account_id
       WHERE e.entry_date BETWEEN $1 AND $2 GROUP BY a.code`,
      [`${YEAR}-04-01`, `${YEAR}-06-30`],
    );
    for (const s of sql) {
      const row = tb.rows.find((x) => x.accountCode === s.code)!;
      expect([row.turnoverDebit, row.turnoverCredit], s.code).toEqual([s.td, s.tc]);
    }
    expect(tb.totals.turnoverDebit).toBe(tb.totals.turnoverCredit);
    expect(tb.totals.closingDebit).toBe(tb.totals.closingCredit);
  }, 180_000); // 200 separate transactions with audit trail
});
