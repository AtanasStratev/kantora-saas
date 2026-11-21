'use server';
import { can, isRole, type Role } from '@kantora/domain';
import { withTenant } from '@kantora/db';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseError } from 'pg';
import { z } from 'zod';
import { getAppContext } from '@/lib/context';
import { appPool } from '@/lib/db';
import { env } from '@/lib/env';

type Result = { error?: string };

/** Every team action re-checks the permission; RLS enforces it again in the database. */
async function ownerContext() {
  const ctx = await getAppContext();
  if (!ctx.office || !isRole(ctx.office.role) || !can(ctx.office.role, 'team.manage')) {
    return null;
  }
  return { userId: ctx.user.id, officeId: ctx.office.id, ctx };
}

function dbError(err: unknown): Result {
  if (err instanceof DatabaseError) {
    if (err.code === '23505') return { error: 'За този имейл вече има отворена покана.' };
    if (['42501', '22023', '23514'].includes(err.code ?? '')) return { error: err.message };
  }
  throw err;
}

const Invite = z.object({
  email: z.email('Имейлът не е валиден. Проверете за правописна грешка.').trim().toLowerCase(),
  role: z.string().refine(isRole, 'Изберете роля.'),
});

export async function createInvitation(input: {
  email: string;
  role: string;
}): Promise<Result & { link?: string }> {
  const owner = await ownerContext();
  if (!owner) return { error: 'Само собственикът на кантората кани потребители.' };
  const parsed = Invite.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Невалидни данни.' };
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest();
  try {
    await withTenant(appPool, owner, (c) =>
      c.query(
        'INSERT INTO app.invitation (office_id, email, role, token_hash, invited_by) VALUES ($1, $2, $3, $4, $5)',
        [owner.officeId, parsed.data.email, parsed.data.role, hash, owner.userId],
      ),
    );
  } catch (err) {
    return dbError(err);
  }
  // The token is returned once and never stored; only its hash is in the database.
  return { link: `${env.BETTER_AUTH_URL}/invite/${token}` };
}

export async function revokeInvitation(invitationId: string): Promise<Result> {
  const owner = await ownerContext();
  if (!owner) return { error: 'Само собственикът на кантората управлява поканите.' };
  await withTenant(appPool, owner, (c) =>
    c.query('UPDATE app.invitation SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL', [
      z.uuid().parse(invitationId),
    ]),
  );
  return {};
}

export async function changeRole(userId: string, role: Role): Promise<Result> {
  const owner = await ownerContext();
  if (!owner) return { error: 'Само собственикът на кантората сменя роли.' };
  if (!isRole(role)) return { error: 'Непозната роля.' };
  try {
    await withTenant(appPool, owner, (c) =>
      c.query('UPDATE app.office_membership SET role = $1 WHERE office_id = $2 AND user_id = $3', [
        role,
        owner.officeId,
        z.uuid().parse(userId),
      ]),
    );
    return {};
  } catch (err) {
    return dbError(err);
  }
}

export async function removeMember(userId: string): Promise<Result> {
  const owner = await ownerContext();
  if (!owner) return { error: 'Само собственикът на кантората премахва членове.' };
  try {
    await withTenant(appPool, owner, (c) =>
      c.query('DELETE FROM app.office_membership WHERE office_id = $1 AND user_id = $2', [
        owner.officeId,
        z.uuid().parse(userId),
      ]),
    );
    return {};
  } catch (err) {
    return dbError(err);
  }
}

export async function setCompanyAccess(
  userId: string,
  companyId: string,
  granted: boolean,
): Promise<Result> {
  const owner = await ownerContext();
  if (!owner) return { error: 'Само собственикът на кантората дава достъп до фирми.' };
  const uid = z.uuid().parse(userId);
  const cid = z.uuid().parse(companyId);
  await withTenant(appPool, owner, (c) =>
    granted
      ? c.query('INSERT INTO app.company_access VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
          owner.officeId,
          uid,
          cid,
        ])
      : c.query(
          'DELETE FROM app.company_access WHERE office_id = $1 AND user_id = $2 AND company_id = $3',
          [owner.officeId, uid, cid],
        ),
  );
  return {};
}
