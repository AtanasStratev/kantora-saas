import 'server-only';
import { can, isRole, type Permission, type Role } from '@kantora/domain';
import { getAppContext, type AppContext, type PeriodRef } from './context';

export type CompanyScope = {
  ctx: AppContext;
  tenant: { userId: string; officeId: string; companyId: string };
  role: Role;
  period: PeriodRef | null;
};

/**
 * The selected company, or null with a reason when there is none / no permission.
 * Server actions call this first; RLS checks the same things again in the database.
 */
export async function companyScope(
  permission: Permission,
): Promise<CompanyScope | { error: string }> {
  const ctx = await getAppContext();
  if (!ctx.office || !ctx.company) return { error: 'Първо изберете фирма (Ctrl+Shift+K).' };
  const role = ctx.office.role;
  if (!isRole(role) || !can(role, permission)) {
    return { error: 'Нямате право за това действие в тази фирма.' };
  }
  return {
    ctx,
    tenant: { userId: ctx.user.id, officeId: ctx.office.id, companyId: ctx.company.id },
    role,
    period: ctx.period,
  };
}
