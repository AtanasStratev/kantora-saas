import 'server-only';
import type { AnalyticNeeds } from '@kantora/domain';
import { withTenant } from '@kantora/db';
import { appPool } from './db';

export type AccountRow = {
  id: string;
  code: string;
  name: string;
  isPostable: boolean;
  isActive: boolean;
  needs: AnalyticNeeds;
  /** Monetary item in a foreign currency (ADR-0015): lines carry currency and amount. */
  isCurrency: boolean;
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
      needs_counterparty: boolean;
      needs_document: boolean;
      needs_cost_object: boolean;
      is_currency: boolean;
    }>(
      `SELECT id, code, name, is_postable, is_active, needs_counterparty, needs_document,
              needs_cost_object, is_currency FROM app.account`,
    );
    return r.rows
      .map((a) => ({
        id: a.id,
        code: a.code,
        name: a.name,
        isPostable: a.is_postable,
        isActive: a.is_active,
        isCurrency: a.is_currency,
        needs: {
          counterparty: a.needs_counterparty,
          document: a.needs_document,
          costObject: a.needs_cost_object,
        },
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

type Tenant = { userId: string; officeId: string; companyId: string };

export type CounterpartyRow = {
  id: string;
  name: string;
  eik: string | null;
  vatNumber: string | null;
  country: string;
  address: string;
  isActive: boolean;
};

export async function loadCounterparties(tenant: Tenant): Promise<CounterpartyRow[]> {
  return withTenant(appPool, tenant, async (c) => {
    const r = await c.query<{
      id: string;
      name: string;
      eik: string | null;
      vat_number: string | null;
      country: string;
      address: string;
      is_active: boolean;
    }>('SELECT id, name, eik, vat_number, country, address, is_active FROM app.counterparty');
    return r.rows
      .map((x) => ({
        id: x.id,
        name: x.name,
        eik: x.eik,
        vatNumber: x.vat_number,
        country: x.country,
        address: x.address,
        isActive: x.is_active,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'bg'));
  });
}

export type CostObjectRow = { id: string; code: string; name: string; isActive: boolean };

export async function loadCostObjects(tenant: Tenant): Promise<CostObjectRow[]> {
  return withTenant(appPool, tenant, async (c) => {
    const r = await c.query<{ id: string; code: string; name: string; is_active: boolean }>(
      'SELECT id, code, name, is_active FROM app.cost_object',
    );
    return r.rows
      .map((x) => ({ id: x.id, code: x.code, name: x.name, isActive: x.is_active }))
      .sort((a, b) => a.code.localeCompare(b.code, 'bg', { numeric: true }));
  });
}
