import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { NewCompanyForm } from './NewCompanyForm';

export default async function CompaniesPage() {
  const ctx = await getAppContext();
  const canCreate = ctx.office?.role === 'owner' || ctx.office?.role === 'chief_accountant';
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <section>
        <h1 className="mb-4 text-xl font-semibold">Фирми в {ctx.office?.name}</h1>
        {ctx.companies.length === 0 ? (
          <EmptyState
            title="Още няма фирми"
            next={
              canCreate
                ? 'Добавете първата с формата вдясно.'
                : 'Помолете собственика да ви даде достъп.'
            }
          />
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
                <th className="px-2 py-1 font-normal">Наименование</th>
                <th className="px-2 py-1 font-normal">ЕИК</th>
              </tr>
            </thead>
            <tbody>
              {ctx.companies.map((c) => (
                <tr
                  key={c.id}
                  className={`border-b border-line ${ctx.company?.id === c.id ? 'bg-surface-selected' : ''}`}
                  aria-current={ctx.company?.id === c.id ? 'true' : undefined}
                >
                  <td className="px-2 py-1">{c.name}</td>
                  <td className="px-2 py-1 tabular-nums">{c.eik ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {canCreate ? (
        <aside className="rounded border border-line bg-surface-raised p-4">
          <h2 className="mb-3 font-semibold">Нова фирма</h2>
          <NewCompanyForm />
        </aside>
      ) : null}
    </div>
  );
}
