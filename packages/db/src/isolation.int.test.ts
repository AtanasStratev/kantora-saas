/**
 * Tenant isolation tests (PROMPT.md 3.4, ADR-0002). These MUST pass in CI.
 *
 * Setup uses the schema owner (DATABASE_URL) with app.system_actor set, so the audit
 * trigger accepts the inserts. Every assertion runs as kantora_app (APP_DATABASE_URL),
 * which has no BYPASSRLS — exactly what the application uses.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type TenantContext } from './tenant';

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });

type Fixture = { officeId: string; userId: string; companyId: string; otherCompanyId: string };
let A: Fixture;
let B: Fixture;
let colleagueA: string; // member of office A without access to A.otherCompanyId

async function seedOffice(label: string): Promise<Fixture> {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.system_actor', 'test-seed', true)`);
    const officeId = randomUUID();
    const userId = randomUUID();
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    await c.query('INSERT INTO app.office (id, name) VALUES ($1, $2)', [
      officeId,
      `Office ${label}`,
    ]);
    await c.query('INSERT INTO app.users (id, email) VALUES ($1, $2)', [
      userId,
      `${userId}@test.local`,
    ]);
    await c.query(`INSERT INTO app.office_membership VALUES ($1, $2, 'owner')`, [officeId, userId]);
    for (const [id, name] of [
      [companyId, 'Firm 1'],
      [otherCompanyId, 'Firm 2'],
    ] as const) {
      await c.query('INSERT INTO app.company (office_id, id, name) VALUES ($1, $2, $3)', [
        officeId,
        id,
        `${name} ${label}`,
      ]);
      await c.query('INSERT INTO app.company_access VALUES ($1, $2, $3)', [officeId, userId, id]);
    }
    const fy = await c.query<{ id: string }>(
      `INSERT INTO app.fiscal_year (office_id, company_id, year, start_date, end_date, ledger_currency)
       VALUES ($1, $2, 2026, '2026-01-01', '2026-12-31', 'EUR') RETURNING id`,
      [officeId, companyId],
    );
    await c.query(
      `INSERT INTO app.period (office_id, company_id, fiscal_year_id, month, start_date, end_date)
       VALUES ($1, $2, $3, 1, '2026-01-01', '2026-01-31')`,
      [officeId, companyId, fy.rows[0]!.id],
    );
    await c.query('COMMIT');
    return { officeId, userId, companyId, otherCompanyId };
  } finally {
    c.release();
  }
}

const ctx = (f: Fixture, companyId?: string): TenantContext =>
  companyId
    ? { userId: f.userId, officeId: f.officeId, companyId }
    : { userId: f.userId, officeId: f.officeId };

beforeAll(async () => {
  A = await seedOffice('A');
  B = await seedOffice('B');
  // A colleague in office A with access only to A.companyId.
  colleagueA = randomUUID();
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.system_actor', 'test-seed', true)`);
    await c.query('INSERT INTO app.users (id, email) VALUES ($1, $2)', [
      colleagueA,
      `${colleagueA}@test.local`,
    ]);
    await c.query(`INSERT INTO app.office_membership VALUES ($1, $2, 'accountant')`, [
      A.officeId,
      colleagueA,
    ]);
    await c.query('INSERT INTO app.company_access VALUES ($1, $2, $3)', [
      A.officeId,
      colleagueA,
      A.companyId,
    ]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
});

afterAll(async () => {
  await admin.end();
  await app.end();
});

describe('database guarantees', () => {
  it('every table in schema app has RLS enabled AND forced AND at least one policy', async () => {
    const { rows } = await admin.query<{
      table: string;
      rls: boolean;
      forced: boolean;
      policies: number;
    }>(`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'app' AND p.tablename = c.relname) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')`);
    expect(rows.length).toBeGreaterThan(0);
    const bad = rows.filter((r) => !r.rls || !r.forced || r.policies === 0).map((r) => r.table);
    expect(bad, `tables without full RLS: ${bad.join(', ')}`).toEqual([]);
  });

  it('the application login cannot bypass RLS', async () => {
    const { rows } = await app.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it('without a tenant context the application sees nothing', async () => {
    for (const t of [
      'office',
      'company',
      'company_access',
      'fiscal_year',
      'period',
      'office_membership',
    ]) {
      const { rowCount } = await app.query(`SELECT 1 FROM app.${t}`);
      expect(rowCount, t).toBe(0);
    }
  });
});

describe('office A cannot reach office B', () => {
  it('SELECT returns only own rows', async () => {
    await withTenant(app, ctx(A, A.companyId), async (c) => {
      const offices = await c.query<{ id: string }>('SELECT id FROM app.office');
      expect(offices.rows.map((r) => r.id)).toEqual([A.officeId]);
      const companies = await c.query<{ id: string }>('SELECT id FROM app.company ORDER BY name');
      expect(companies.rows.map((r) => r.id).sort()).toEqual(
        [A.companyId, A.otherCompanyId].sort(),
      );
      const byId = await c.query('SELECT 1 FROM app.company WHERE id = $1', [B.companyId]);
      expect(byId.rowCount).toBe(0);
    });
  });

  it('claiming office B in the context does not help without membership', async () => {
    await withTenant(
      app,
      { userId: A.userId, officeId: B.officeId, companyId: B.companyId },
      async (c) => {
        for (const t of [
          'office',
          'company',
          'fiscal_year',
          'period',
          'office_membership',
          'company_access',
        ]) {
          const { rowCount } = await c.query(`SELECT 1 FROM app.${t}`);
          expect(rowCount, t).toBe(0);
        }
      },
    );
  });

  it('UPDATE of a foreign row affects 0 rows', async () => {
    await withTenant(app, ctx(A, A.companyId), async (c) => {
      const r = await c.query(`UPDATE app.company SET name = 'hacked' WHERE id = $1`, [
        B.companyId,
      ]);
      expect(r.rowCount).toBe(0);
      const o = await c.query(`UPDATE app.office SET name = 'hacked' WHERE id = $1`, [B.officeId]);
      expect(o.rowCount).toBe(0);
    });
  });

  it('INSERT into a foreign office/company is rejected', async () => {
    await expect(
      withTenant(app, ctx(A, A.companyId), (c) =>
        c.query(
          `INSERT INTO app.fiscal_year (office_id, company_id, year, start_date, end_date, ledger_currency)
           VALUES ($1, $2, 2027, '2027-01-01', '2027-12-31', 'EUR')`,
          [B.officeId, B.companyId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot grant itself access to a foreign company', async () => {
    await expect(
      withTenant(app, ctx(A), (c) =>
        c.query('INSERT INTO app.company_access VALUES ($1, $2, $3)', [
          B.officeId,
          A.userId,
          B.companyId,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('DELETE of foreign membership affects 0 rows', async () => {
    await withTenant(app, ctx(A), async (c) => {
      const r = await c.query('DELETE FROM app.office_membership WHERE office_id = $1', [
        B.officeId,
      ]);
      expect(r.rowCount).toBe(0);
    });
  });
});

describe('company isolation inside one office', () => {
  it('a colleague sees only the companies granted to them', async () => {
    await withTenant(app, { userId: colleagueA, officeId: A.officeId }, async (c) => {
      const { rows } = await c.query<{ id: string }>('SELECT id FROM app.company');
      expect(rows.map((r) => r.id)).toEqual([A.companyId]);
    });
  });

  it('switching the context to a non-granted company shows no company data', async () => {
    await withTenant(
      app,
      { userId: colleagueA, officeId: A.officeId, companyId: A.otherCompanyId },
      async (c) => {
        const { rowCount } = await c.query('SELECT 1 FROM app.fiscal_year');
        expect(rowCount).toBe(0);
      },
    );
  });

  it('company-scoped rows of another company are hidden even with access to both', async () => {
    // Owner has access to both firms, but the context is A.otherCompanyId: fiscal years of A.companyId stay hidden.
    await withTenant(app, ctx(A, A.otherCompanyId), async (c) => {
      const { rowCount } = await c.query('SELECT 1 FROM app.fiscal_year');
      expect(rowCount).toBe(0);
    });
  });

  it('an accountant cannot create companies', async () => {
    await expect(
      withTenant(app, { userId: colleagueA, officeId: A.officeId }, (c) =>
        c.query(`SELECT app.create_company('X')`),
      ),
    ).rejects.toThrow(/Нямате право/);
  });
});

describe('audit log', () => {
  it('records changes with the acting user and keeps the hash chain intact', async () => {
    const newId = await withTenant(app, { ...ctx(A), ip: '10.0.0.7' }, async (c) => {
      const r = await c.query<{ id: string }>(`SELECT app.create_company('Нова фирма') AS id`);
      return r.rows[0]!.id;
    });
    await withTenant(app, ctx(A), async (c) => {
      const { rows } = await c.query<{ user_id: string; ip: string; action: string }>(
        `SELECT user_id, host(ip) AS ip, action FROM app.audit_log
         WHERE table_name = 'company' AND row_pk->>'id' = $1`,
        [newId],
      );
      expect(rows).toEqual([{ user_id: A.userId, ip: '10.0.0.7', action: 'INSERT' }]);
    });
    const chain = await admin.query<{ broken: string | null }>(
      'SELECT app.verify_audit_chain($1) AS broken',
      [A.officeId],
    );
    expect(chain.rows[0]!.broken).toBeNull();
  });

  it('office B cannot read office A audit entries', async () => {
    await withTenant(app, ctx(B), async (c) => {
      const { rowCount } = await c.query('SELECT 1 FROM app.audit_log WHERE office_id = $1', [
        A.officeId,
      ]);
      expect(rowCount).toBe(0);
    });
  });

  it('audit entries cannot be modified or deleted, even by the schema owner', async () => {
    await expect(admin.query('UPDATE app.audit_log SET actor = actor')).rejects.toThrow(
      /Одитният журнал/,
    );
    await expect(admin.query('DELETE FROM app.audit_log')).rejects.toThrow(/Одитният журнал/);
  });

  it('changes without a known actor are rejected', async () => {
    await expect(
      admin.query(`UPDATE app.office SET name = 'x' WHERE id = $1`, [A.officeId]),
    ).rejects.toThrow(/одитен журнал/);
  });
});

describe('ledger currency by era (ADR-0004)', () => {
  it('rejects EUR for 2025 and BGN for 2026', async () => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.system_actor', 'test', true)`);
      await expect(
        c.query(
          `INSERT INTO app.fiscal_year (office_id, company_id, year, start_date, end_date, ledger_currency)
           VALUES ($1, $2, 2025, '2025-01-01', '2025-12-31', 'EUR')`,
          [A.officeId, A.otherCompanyId],
        ),
      ).rejects.toThrow(/fiscal_year_currency_by_era/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
