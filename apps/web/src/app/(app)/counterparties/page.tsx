import { can, isRole } from '@kantora/domain';
import Link from 'next/link';
import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { loadCounterparties } from '@/lib/ledger-data';
import { CounterpartyActive, NewCounterpartyForm } from './forms';

/** Контрагенти of the company (ADR-0014). New ones also from the entry grid. */
export default async function CounterpartiesPage() {
  const ctx = await getAppContext();
  const role = ctx.office?.role;
  if (!ctx.office || !ctx.company) {
    return (
      <EmptyState
        title="Изберете фирма"
        next="Контрагентите са отделни за всяка фирма:"
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
  const list = await loadCounterparties({
    userId: ctx.user.id,
    officeId: ctx.office.id,
    companyId: ctx.company.id,
  });
  const canEdit = can(role, 'accounting.post');

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <section>
        <h1 className="mb-1 text-xl font-semibold">Контрагенти — {ctx.company.name}</h1>
        <p className="mb-4 text-sm text-fg-muted">
          Нов контрагент се добавя и направо от „Нова статия“. Неактивният остава в справките, но не
          се избира в нови статии.
        </p>
        {list.length === 0 ? (
          <EmptyState
            title="Още няма контрагенти"
            next={canEdit ? 'Добавете първия с формата вдясно.' : 'Счетоводителят ги добавя.'}
          />
        ) : (
          <table className="w-full border-collapse text-sm" aria-label="Контрагенти">
            <thead>
              <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
                <th className="px-2 py-1 font-normal">Наименование</th>
                <th className="w-32 px-2 py-1 font-normal">ЕИК</th>
                <th className="w-36 px-2 py-1 font-normal">ДДС номер</th>
                <th className="w-28 px-2 py-1 font-normal">Състояние</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className="border-b border-line">
                  <td className="px-2 py-1">
                    <Link
                      className="text-accent underline"
                      href={`/counterparties/${c.id}`}
                      title="Извлечение по контрагента"
                    >
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-2 py-1 tabular-nums">{c.eik ?? '—'}</td>
                  <td className="px-2 py-1 tabular-nums">{c.vatNumber ?? '—'}</td>
                  <td className="px-2 py-1 text-xs">
                    {canEdit ? (
                      <CounterpartyActive id={c.id} active={c.isActive} />
                    ) : c.isActive ? (
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
          <h2 className="mb-3 font-semibold">Нов контрагент</h2>
          <NewCounterpartyForm />
        </aside>
      ) : null}
    </div>
  );
}
