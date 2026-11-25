import { can, isRole } from '@kantora/domain';
import { loadVatSettings, withTenant } from '@kantora/db';
import Link from 'next/link';
import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { appPool } from '@/lib/db';
import { loadAccounts } from '@/lib/ledger-data';
import { VatSettingsForm } from './VatSettingsForm';

/** Which accounts VAT documents post to (ADR-0018). The chart is data: no numbers in code. */
export default async function VatSettingsPage() {
  const ctx = await getAppContext();
  const role = ctx.office?.role;
  if (!ctx.office || !ctx.company) {
    return <EmptyState title="Изберете фирма" next="Смяна на фирма:" shortcut="Ctrl+Shift+K" />;
  }
  if (!isRole(role) || !can(role, 'accounting.view')) {
    return (
      <EmptyState
        title="Нямате достъп до счетоводството"
        next="Обърнете се към собственика на кантората."
      />
    );
  }
  const tenant = { userId: ctx.user.id, officeId: ctx.office.id, companyId: ctx.company.id };
  const [settings, accounts] = await Promise.all([
    withTenant(appPool, tenant, loadVatSettings),
    loadAccounts(tenant),
  ]);
  return (
    <div className="max-w-3xl">
      <p className="mb-2 text-sm">
        <Link className="text-accent underline" href="/vat">
          ← Документи по ДДС
        </Link>
      </p>
      <h1 className="mb-1 text-xl font-semibold">Настройки на ДДС — {ctx.company.name}</h1>
      <p className="mb-4 text-sm text-fg-muted">
        По кои сметки се осчетоводяват документите. Сметките с контрагент и документ получават
        контрагента и номера на документа.
      </p>
      <VatSettingsForm
        canEdit={can(role, 'company.edit')}
        settings={settings}
        accounts={accounts
          .filter((a) => a.isPostable && a.isActive)
          .map((a) => ({ id: a.id, label: `${a.code} ${a.name}` }))}
      />
    </div>
  );
}
