import { can, isRole } from '@kantora/domain';
import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { loadCostObjects } from '@/lib/ledger-data';
import { CostObjectActive, NewCostObjectForm } from '../counterparties/forms';

/** Обекти (места на разходи) of the company (ADR-0014). Managed like the chart of accounts. */
export default async function CostObjectsPage() {
  const ctx = await getAppContext();
  const role = ctx.office?.role;
  if (!ctx.office || !ctx.company) {
    return (
      <EmptyState
        title="Изберете фирма"
        next="Обектите са отделни за всяка фирма:"
        shortcut="Ctrl+Shift+K"
      />
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
  const list = await loadCostObjects({
    userId: ctx.user.id,
    officeId: ctx.office.id,
    companyId: ctx.company.id,
  });
  const canEdit = can(role, 'company.edit');

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <section>
        <h1 className="mb-1 text-xl font-semibold">Обекти — {ctx.company.name}</h1>
        <p className="mb-4 text-sm text-fg-muted">
          Обекти или места на разходи. Сметка, която ги изисква, се отбелязва в сметкоплана.
        </p>
        {list.length === 0 ? (
          <EmptyState
            title="Още няма обекти"
            next={
              canEdit ? 'Добавете първия с формата вдясно.' : 'Главният счетоводител ги добавя.'
            }
          />
        ) : (
          <table className="w-full border-collapse text-sm" aria-label="Обекти">
            <thead>
              <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
                <th className="w-28 px-2 py-1 font-normal">Код</th>
                <th className="px-2 py-1 font-normal">Наименование</th>
                <th className="w-28 px-2 py-1 font-normal">Състояние</th>
              </tr>
            </thead>
            <tbody>
              {list.map((o) => (
                <tr key={o.id} className="border-b border-line">
                  <td className="px-2 py-1 tabular-nums">{o.code}</td>
                  <td className="px-2 py-1">{o.name}</td>
                  <td className="px-2 py-1 text-xs">
                    {canEdit ? (
                      <CostObjectActive id={o.id} active={o.isActive} />
                    ) : o.isActive ? (
                      'активен'
                    ) : (
                      'неактивен'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {canEdit ? (
        <aside className="rounded border border-line bg-surface-raised p-4">
          <h2 className="mb-3 font-semibold">Нов обект</h2>
          <NewCostObjectForm />
        </aside>
      ) : null}
    </div>
  );
}
