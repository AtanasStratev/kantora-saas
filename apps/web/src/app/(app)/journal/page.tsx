import { can, formatAmount, formatDate, isRole } from '@kantora/domain';
import Link from 'next/link';
import { Badge, EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { ExportLinks } from '@/components/ExportLinks';
import { journalList } from '@/lib/reports';
import { periodLabel } from '@/lib/period';
import { PeriodLockButton } from './PeriodLockButton';

export default async function JournalPage() {
  const ctx = await getAppContext();
  const role = ctx.office?.role;
  if (!ctx.office || !ctx.company || !ctx.period) {
    return (
      <EmptyState title="Изберете фирма и период" next="Смяна на фирма:" shortcut="Ctrl+Shift+K" />
    );
  }
  if (!isRole(role) || !can(role, 'accounting.view')) {
    return (
      <EmptyState
        title="Нямате достъп до счетоводството"
        next="Обърнете се към собственика на кантората."
      />
    );
  }
  const period = ctx.period;
  const tenant = { userId: ctx.user.id, officeId: ctx.office.id, companyId: ctx.company.id };
  const rows = await journalList(tenant, period.id);
  const canPost = can(role, 'accounting.post') && !period.locked;

  return (
    <div className="max-w-5xl">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">
          Статии — {periodLabel(period)} {period.locked ? <Badge kind="locked" /> : null}
        </h1>
        <span className="ml-auto flex items-center gap-3">
          {rows.length > 0 ? <ExportLinks report="journal" params={{}} /> : null}
          <Link href="/journal/templates" className="text-accent underline">
            Шаблони
          </Link>
          {canPost ? (
            <Link
              href="/journal/new"
              className="rounded bg-accent px-3 py-1.5 font-medium text-accent-fg"
            >
              Нова статия (F2)
            </Link>
          ) : null}
          {can(role, 'period.lock') ? (
            <PeriodLockButton
              periodId={period.id}
              locked={period.locked}
              label={periodLabel(period)}
            />
          ) : null}
        </span>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          title={`Няма осчетоводени статии за ${periodLabel(period)}`}
          next={canPost ? 'Въведете първата с' : 'Изберете друг период с Alt+P.'}
          {...(canPost ? { shortcut: 'F2' } : {})}
        />
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
              <th className="w-16 px-2 py-1 text-right font-normal">№</th>
              <th className="w-28 px-2 py-1 font-normal">Дата</th>
              <th className="px-2 py-1 font-normal">Основание</th>
              <th className="w-36 px-2 py-1 text-right font-normal">Сума</th>
              <th className="w-32 px-2 py-1 font-normal">Състояние</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line">
                <td className="px-2 py-1 text-right tabular-nums">
                  <Link href={`/journal/${r.id}`} className="text-accent underline">
                    {r.number}
                  </Link>
                </td>
                <td className="px-2 py-1 tabular-nums">{formatDate(r.entry_date)}</td>
                <td className="px-2 py-1">
                  {r.description || <span className="text-fg-muted">—</span>}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{formatAmount(r.total)}</td>
                <td className="px-2 py-1">
                  {r.reverses_entry_id ? (
                    <Badge kind="warning">Сторно</Badge>
                  ) : r.reversed_by ? (
                    <Badge kind="reversed" />
                  ) : (
                    <Badge kind="posted" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
