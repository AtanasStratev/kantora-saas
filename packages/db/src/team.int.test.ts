/** Invitations, roles and company access (PRD §2, migration 20261121140000). */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { withTenant, withUser } from './tenant';

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

async function authUser(
  email = `${randomUUID()}@test.local`,
): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  await admin.query('INSERT INTO auth."user" (id, name, email) VALUES ($1, $2, $3)', [
    id,
    'Т',
    email,
  ]);
  return { id, email };
}

async function ownerWithOffice(): Promise<{ userId: string; officeId: string }> {
  const u = await authUser();
  const officeId = await withUser(app, u.id, async (c) => {
    const r = await c.query<{ id: string }>(`SELECT app.register_office('Екип') AS id`);
    return r.rows[0]!.id;
  });
  return { userId: u.id, officeId };
}

function newToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token).digest() };
}

async function invite(owner: { userId: string; officeId: string }, email: string, role: string) {
  const t = newToken();
  await withTenant(app, owner, (c) =>
    c.query(
      'INSERT INTO app.invitation (office_id, email, role, token_hash, invited_by) VALUES ($1, $2, $3, $4, $5)',
      [owner.officeId, email, role, t.hash, owner.userId],
    ),
  );
  return t.token;
}

const accept = (userId: string, token: string) =>
  withUser(app, userId, (c) => c.query('SELECT app.accept_invitation($1) AS office', [token]));

describe('invitations', () => {
  it('the invited user joins with the invited role; the link cannot be reused', async () => {
    const owner = await ownerWithOffice();
    const invitee = await authUser();
    const token = await invite(owner, invitee.email.toUpperCase(), 'accountant');

    const preview = await app.query('SELECT * FROM app.invitation_preview($1)', [token]);
    expect(preview.rows[0]).toMatchObject({
      office_name: 'Екип',
      role: 'accountant',
      status: 'open',
    });

    await accept(invitee.id, token);
    const offices = await withUser(
      app,
      invitee.id,
      async (c) => (await c.query('SELECT office_id, role FROM app.my_offices()')).rows,
    );
    expect(offices).toEqual([{ office_id: owner.officeId, role: 'accountant' }]);
    await expect(accept(invitee.id, token)).rejects.toThrow(/вече е използвана/);
  });

  it('rejects a different signed-in e-mail', async () => {
    const owner = await ownerWithOffice();
    const token = await invite(owner, 'someone@test.local', 'read_only');
    const other = await authUser();
    await expect(accept(other.id, token)).rejects.toThrow(/Поканата е за someone@test.local/);
  });

  it('rejects expired, revoked and unknown tokens', async () => {
    const owner = await ownerWithOffice();
    const a = await authUser();
    const expired = await invite(owner, a.email, 'read_only');
    // Simulate the passage of time as a system job (the audit trigger requires an actor).
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.system_actor', 'test-clock', true)`);
      await c.query(
        `UPDATE app.invitation SET expires_at = now() - interval '1 minute' WHERE lower(email) = lower($1)`,
        [a.email],
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await expect(accept(a.id, expired)).rejects.toThrow(/изтекла/);

    const b = await authUser();
    const revoked = await invite(owner, b.email, 'read_only');
    await withTenant(app, owner, (c) =>
      c.query('UPDATE app.invitation SET revoked_at = now() WHERE lower(email) = lower($1)', [
        b.email,
      ]),
    );
    await expect(accept(b.id, revoked)).rejects.toThrow(/не е валидна/);
    await expect(accept(b.id, 'no-such-token')).rejects.toThrow(/не е валидна/);
  });

  it('only the owner can invite, and only into their own office', async () => {
    const owner = await ownerWithOffice();
    const acc = await authUser();
    await accept(acc.id, await invite(owner, acc.email, 'accountant'));
    const t = newToken();
    await expect(
      withTenant(app, { userId: acc.id, officeId: owner.officeId }, (c) =>
        c.query(
          'INSERT INTO app.invitation (office_id, email, role, token_hash, invited_by) VALUES ($1, $2, $3, $4, $5)',
          [owner.officeId, 'x@test.local', 'owner', t.hash, acc.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);

    const otherOwner = await ownerWithOffice();
    const seen = await withTenant(app, otherOwner, (c) =>
      c.query('SELECT 1 FROM app.invitation WHERE office_id = $1', [owner.officeId]),
    );
    expect(seen.rowCount).toBe(0);
  });
});

describe('the office always keeps an owner', () => {
  it('blocks demoting or removing the last owner, allows it once there is another', async () => {
    const owner = await ownerWithOffice();
    await expect(
      withTenant(app, owner, (c) =>
        c.query(`UPDATE app.office_membership SET role = 'accountant' WHERE user_id = $1`, [
          owner.userId,
        ]),
      ),
    ).rejects.toThrow(/поне един собственик/);
    await expect(
      withTenant(app, owner, (c) =>
        c.query('DELETE FROM app.office_membership WHERE user_id = $1', [owner.userId]),
      ),
    ).rejects.toThrow(/поне един собственик/);

    const second = await authUser();
    await accept(second.id, await invite(owner, second.email, 'owner'));
    const r = await withTenant(app, owner, (c) =>
      c.query(`UPDATE app.office_membership SET role = 'chief_accountant' WHERE user_id = $1`, [
        owner.userId,
      ]),
    );
    expect(r.rowCount).toBe(1);
  });
});

describe('company access by role', () => {
  it('the owner sees every company; an accountant only granted ones', async () => {
    const owner = await ownerWithOffice();
    const chief = await authUser();
    const acc = await authUser();
    await accept(chief.id, await invite(owner, chief.email, 'chief_accountant'));
    await accept(acc.id, await invite(owner, acc.email, 'accountant'));

    // The chief accountant creates a company: only the chief has an access row for it.
    const chiefCompany = await withTenant(
      app,
      { userId: chief.id, officeId: owner.officeId },
      async (c) =>
        (await c.query<{ id: string }>(`SELECT app.create_company('От главния') AS id`)).rows[0]!
          .id,
    );
    const ownerSees = await withTenant(app, owner, async (c) =>
      (await c.query<{ id: string }>('SELECT id FROM app.company')).rows.map((x) => x.id),
    );
    expect(ownerSees).toContain(chiefCompany);

    const accSeesBefore = await withTenant(app, { userId: acc.id, officeId: owner.officeId }, (c) =>
      c.query('SELECT 1 FROM app.company'),
    );
    expect(accSeesBefore.rowCount).toBe(0);

    await withTenant(app, owner, (c) =>
      c.query('INSERT INTO app.company_access VALUES ($1, $2, $3)', [
        owner.officeId,
        acc.id,
        chiefCompany,
      ]),
    );
    const accSeesAfter = await withTenant(
      app,
      { userId: acc.id, officeId: owner.officeId },
      async (c) =>
        (await c.query<{ id: string }>('SELECT id FROM app.company')).rows.map((x) => x.id),
    );
    expect(accSeesAfter).toEqual([chiefCompany]);

    // The accountant cannot grant access to anyone (owner-only policy).
    await expect(
      withTenant(app, { userId: acc.id, officeId: owner.officeId }, (c) =>
        c.query('INSERT INTO app.company_access VALUES ($1, $2, $3)', [
          owner.officeId,
          chief.id,
          chiefCompany,
        ]),
      ),
    ).rejects.toThrow(/row-level security|duplicate key/);
  });
});
