/**
 * Boundary between authentication (schema auth, role auth_service) and business data
 * (schema app, role app_user), plus office registration (ADR-0005, ADR-0002).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { withTenant, withUser } from './tenant';

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
const authRole = new pg.Pool({ connectionString: process.env.AUTH_DATABASE_URL });

afterAll(async () => {
  await Promise.all([admin.end(), app.end(), authRole.end()]);
});

async function createAuthUser(name = 'Тест'): Promise<string> {
  const id = randomUUID();
  await admin.query('INSERT INTO auth."user" (id, name, email) VALUES ($1, $2, $3)', [
    id,
    name,
    `${id}@test.local`,
  ]);
  return id;
}

describe('role separation', () => {
  it('the application role cannot read authentication data', async () => {
    await expect(app.query('SELECT 1 FROM auth."user"')).rejects.toThrow(/permission denied/);
    await expect(app.query('SELECT 1 FROM auth.account')).rejects.toThrow(/permission denied/);
    await expect(app.query('SELECT 1 FROM auth."twoFactor"')).rejects.toThrow(/permission denied/);
  });

  it('the auth role cannot read business data', async () => {
    await expect(authRole.query('SELECT 1 FROM app.office')).rejects.toThrow(/permission denied/);
    await expect(authRole.query('SELECT 1 FROM app.company')).rejects.toThrow(/permission denied/);
  });

  it('the auth role can work with its own tables', async () => {
    const { rowCount } = await authRole.query('SELECT 1 FROM auth."user" LIMIT 1');
    expect(rowCount).toBeGreaterThanOrEqual(0);
  });
});

describe('office registration', () => {
  it('links the signed-in user and makes them owner of a new office', async () => {
    const userId = await createAuthUser('Мария');
    const officeId = await withUser(app, userId, async (c) => {
      const r = await c.query<{ id: string }>(`SELECT app.register_office('Кантора Мария') AS id`);
      return r.rows[0]!.id;
    });
    const offices = await withUser(app, userId, async (c) => {
      const r = await c.query<{ office_id: string; role: string }>(
        'SELECT * FROM app.my_offices()',
      );
      return r.rows;
    });
    expect(offices).toEqual([{ office_id: officeId, office_name: 'Кантора Мария', role: 'owner' }]);

    // Registration is audited with the acting user.
    await withTenant(app, { userId, officeId }, async (c) => {
      const r = await c.query<{ user_id: string }>(
        `SELECT user_id FROM app.audit_log WHERE table_name = 'office' AND row_pk->>'id' = $1`,
        [officeId],
      );
      expect(r.rows).toEqual([{ user_id: userId }]);
    });
  });

  it('cannot register twice for the same user', async () => {
    const userId = await createAuthUser();
    await withUser(app, userId, (c) => c.query(`SELECT app.register_office('Първа')`));
    await expect(
      withUser(app, userId, (c) => c.query(`SELECT app.register_office('Втора')`)),
    ).rejects.toThrow(/вече е свързан/);
  });

  it('rejects a user id that has no authentication account', async () => {
    await expect(
      withUser(app, randomUUID(), (c) => c.query(`SELECT app.register_office('Фалшива')`)),
    ).rejects.toThrow(/Непознат потребител/);
  });

  it('rejects an empty office name', async () => {
    const userId = await createAuthUser();
    await expect(
      withUser(app, userId, (c) => c.query(`SELECT app.register_office('   ')`)),
    ).rejects.toThrow(/Въведете име/);
  });

  it('my_offices shows only the signed-in user’s offices', async () => {
    const a = await createAuthUser();
    const b = await createAuthUser();
    await withUser(app, a, (c) => c.query(`SELECT app.register_office('Офис А')`));
    await withUser(app, b, (c) => c.query(`SELECT app.register_office('Офис Б')`));
    const seenByA = await withUser(app, a, async (c) => {
      const r = await c.query<{ office_name: string }>('SELECT office_name FROM app.my_offices()');
      return r.rows.map((x) => x.office_name);
    });
    expect(seenByA).toEqual(['Офис А']);
    const noUser = await app.query('SELECT * FROM app.my_offices()');
    expect(noUser.rowCount).toBe(0);
  });
});
