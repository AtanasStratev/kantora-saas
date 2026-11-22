import { can, isRole } from '@kantora/domain';
import Link from 'next/link';
import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { loadAccounts } from '@/lib/ledger-data';
import { periodLabel } from '@/lib/period';
import { EntryForm } from './EntryForm';

export default async function NewEntryPage() {
  const ctx = await getAppContext();
  const role = ctx.office?.role;
  if (!ctx.office || !ctx.company || !ctx.period) {
    return (
      <EmptyState title="Изберете фирма и период" next="Смяна на фирма:" shortcut="Ctrl+Shift+K" />
    );
  }
  if (!isRole(role) || !can(role, 'accounting.post')) {
    return (
      <EmptyState
        title="Нямате право да осчетоводявате"
        next="Обърнете се към собственика на кантората."
      />
    );
  }
  if (ctx.period.locked) {
    return (
      <EmptyState
        title={`Период ${periodLabel(ctx.period)} е заключен`}
        next="Изберете друг период (Alt+P) или помолете главния счетоводител да го отключи."
      />
    );
  }
  const accounts = await loadAccounts({
    userId: ctx.user.id,
    officeId: ctx.office.id,
    companyId: ctx.company.id,
  });
  if (!accounts.some((a) => a.isPostable && a.isActive)) {
    return (
      <div>
        <EmptyState
          title="Няма сметки за осчетоводяване"
          next="Първо добавете сметки в сметкоплана."
          shortcut="g s"
        />
        <p className="mt-3 text-center text-sm">
          <Link className="text-accent underline" href="/accounts">
            Към сметкоплана
          </Link>
        </p>
      </div>
    );
  }
  const y = ctx.period.year;
  const m = ctx.period.month;
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const defaultDate = todayIso >= first && todayIso <= last ? todayIso : last;

  return (
    <div className="max-w-5xl">
      <h1 className="mb-1 text-xl font-semibold">Нова статия — {ctx.company.name}</h1>
      <p className="mb-4 text-sm text-fg-muted">
        Сумите са в {ctx.period.ledgerCurrency}, отчетната валута на {y} г.
      </p>
      <EntryForm
        accounts={accounts}
        period={{ year: y, month: m, today: todayIso, label: periodLabel(ctx.period) }}
        defaultDate={defaultDate}
      />
    </div>
  );
}
