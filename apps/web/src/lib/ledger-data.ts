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

export type TemplateRow = {
  id: string;
  name: string;
  description: string;
  lines: {
    accountId: string;
    side: 'D' | 'C';
    amount: string | null;
    description: string;
  }[];
};

/** Entry templates of the current company, with their lines in order. */
export async function loadTemplates(tenant: {
  userId: string;
  officeId: string;
  companyId: string;
}): Promise<TemplateRow[]> {
  return withTenant(appPool, tenant, async (c) => {
    const t = await c.query<{ id: string; name: string; description: string }>(
      'SELECT id, name, description FROM app.entry_template',
    );
    const l = await c.query<{
      template_id: string;
      account_id: string;
      side: 'D' | 'C';
      amount: string | null;
      description: string;
    }>(
      `SELECT template_id, account_id, side, amount::text, description
       FROM app.entry_template_line ORDER BY template_id, line_no`,
    );
    return t.rows
      .map((x) => ({
        ...x,
        lines: l.rows
          .filter((y) => y.template_id === x.id)
          .map((y) => ({
            accountId: y.account_id,
            side: y.side,
            amount: y.amount,
            description: y.description,
          })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'bg'));
  });
}
