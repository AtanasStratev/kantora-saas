import 'server-only';
import { withTenant } from '@kantora/db';
import { appPool } from './db';

export type AccountRow = {
  id: string;
  code: string;
  name: string;
  isPostable: boolean;
  isActive: boolean;
};

export async function loadAccounts(tenant: {
  userId: string;
  officeId: string;
  companyId: string;
}): Promise<AccountRow[]> {
  return withTenant(appPool, tenant, async (c) => {
    const r = await c.query<{
      id: string;
      code: string;
      name: string;
      is_postable: boolean;
      is_active: boolean;
    }>('SELECT id, code, name, is_postable, is_active FROM app.account');
    return r.rows
      .map((a) => ({
        id: a.id,
        code: a.code,
        name: a.name,
        isPostable: a.is_postable,
        isActive: a.is_active,
      }))
      .sort((a, b) => a.code.localeCompare(b.code, 'bg', { numeric: true }));
  });
}
