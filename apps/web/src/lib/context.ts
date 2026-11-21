import 'server-only';
import { withTenant, withUser } from '@kantora/db';
import { cookies } from 'next/headers';
import { appPool } from './db';
import { requireSession } from './session';

export const OFFICE_COOKIE = 'kantora-office';
export const COMPANY_COOKIE = 'kantora-company';
export const PERIOD_COOKIE = 'kantora-period';

export type OfficeRef = { id: string; name: string; role: string };
export type CompanyRef = { id: string; name: string; eik: string | null };
export type PeriodRef = {
  id: string;
  year: number;
  month: number;
  ledgerCurrency: 'BGN' | 'EUR';
  locked: boolean;
};

export type AppContext = {
  user: { id: string; name: string; email: string };
  offices: OfficeRef[];
  office: OfficeRef | null;
  companies: CompanyRef[];
  company: CompanyRef | null;
  periods: PeriodRef[];
  period: PeriodRef | null;
};

/**
 * Current office, company and period for the signed-in user. Selections come from
 * cookies but are only accepted if they appear in lists read under RLS, so a forged
 * cookie can never select data the user has no access to.
 */
export async function getAppContext(): Promise<AppContext> {
  const session = await requireSession();
  const jar = await cookies();
  const user = { id: session.user.id, name: session.user.name, email: session.user.email };

  const offices = await withUser(appPool, user.id, async (c) => {
    const r = await c.query<{ office_id: string; office_name: string; role: string }>(
      'SELECT * FROM app.my_offices()',
    );
    return r.rows.map((o) => ({ id: o.office_id, name: o.office_name, role: o.role }));
  });
  const office = offices.find((o) => o.id === jar.get(OFFICE_COOKIE)?.value) ?? offices[0] ?? null;
  if (!office) {
    return { user, offices, office: null, companies: [], company: null, periods: [], period: null };
  }

  const companies = await withTenant(
    appPool,
    { userId: user.id, officeId: office.id },
    async (c) => {
      const r = await c.query<CompanyRef>('SELECT id, name, eik FROM app.company ORDER BY name');
      return r.rows;
    },
  );
  const company = companies.find((x) => x.id === jar.get(COMPANY_COOKIE)?.value) ?? null;
  if (!company) {
    return { user, offices, office, companies, company: null, periods: [], period: null };
  }

  const periods = await withTenant(
    appPool,
    { userId: user.id, officeId: office.id, companyId: company.id },
    async (c) => {
      const r = await c.query<{
        id: string;
        year: number;
        month: number;
        ledger_currency: 'BGN' | 'EUR';
        locked: boolean;
      }>(
        `SELECT p.id, fy.year, p.month, fy.ledger_currency, p.locked_at IS NOT NULL AS locked
         FROM app.period p JOIN app.fiscal_year fy ON fy.id = p.fiscal_year_id
         ORDER BY fy.year DESC, p.month DESC`,
      );
      return r.rows.map((p) => ({
        id: p.id,
        year: p.year,
        month: p.month,
        ledgerCurrency: p.ledger_currency,
        locked: p.locked,
      }));
    },
  );
  const now = new Date();
  const period =
    periods.find((p) => p.id === jar.get(PERIOD_COOKIE)?.value) ??
    periods.find((p) => p.year === now.getFullYear() && p.month === now.getMonth() + 1) ??
    periods[0] ??
    null;

  return { user, offices, office, companies, company, periods, period };
}
