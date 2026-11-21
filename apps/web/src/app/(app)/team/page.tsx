import { can, isRole } from '@kantora/domain';
import { withTenant } from '@kantora/db';
import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { appPool } from '@/lib/db';
import { TeamManager, type InvitationRow, type MemberRow } from './TeamManager';

export default async function TeamPage() {
  const ctx = await getAppContext();
  const role = ctx.office?.role;
  if (!ctx.office || !isRole(role) || !can(role, 'team.manage')) {
    return (
      <EmptyState
        title="Екипът се управлява от собственика на кантората"
        next="Ако ви трябва достъп до още фирми, обърнете се към собственика."
      />
    );
  }
  const scope = { userId: ctx.user.id, officeId: ctx.office.id };
  const { members, invitations } = await withTenant(appPool, scope, async (c) => {
    const m = await c.query<{ user_id: string; full_name: string; email: string; role: string }>(
      `SELECT m.user_id, u.full_name, u.email, m.role
       FROM app.office_membership m JOIN app.users u ON u.id = m.user_id
       ORDER BY u.full_name`,
    );
    const a = await c.query<{ user_id: string; company_id: string }>(
      'SELECT user_id, company_id FROM app.company_access',
    );
    const i = await c.query<{ id: string; email: string; role: string; expires_at: Date }>(
      `SELECT id, email, role, expires_at FROM app.invitation
       WHERE accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC`,
    );
    const members: MemberRow[] = m.rows.map((r) => ({
      userId: r.user_id,
      name: r.full_name,
      email: r.email,
      role: isRole(r.role) ? r.role : 'read_only',
      companyIds: a.rows.filter((x) => x.user_id === r.user_id).map((x) => x.company_id),
      isSelf: r.user_id === ctx.user.id,
    }));
    const invitations: InvitationRow[] = i.rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: isRole(r.role) ? r.role : 'read_only',
      expired: r.expires_at.getTime() < Date.now(),
      expiresAt: r.expires_at.toISOString().slice(0, 10),
    }));
    return { members, invitations };
  });

  return (
    <TeamManager
      officeName={ctx.office.name}
      members={members}
      invitations={invitations}
      companies={ctx.companies.map((c) => ({ id: c.id, name: c.name }))}
    />
  );
}
