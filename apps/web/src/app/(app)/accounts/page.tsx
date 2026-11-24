import { can, isRole } from '@kantora/domain';
import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { loadAccounts } from '@/lib/ledger-data';
import { AccountNeed } from '../counterparties/forms';
import { NewAccountForm } from './NewAccountForm';

export default async function AccountsPage() {
  const ctx = await getAppContext();
  const role = ctx.office?.role;
  if (!ctx.office || !ctx.company) {
    return (
      <EmptyState
        title="Изберете фирма"
        next="Сметкопланът е отделен за всяка фирма:"
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
  const accounts = await loadAccounts({
    userId: ctx.user.id,
    officeId: ctx.office.id,
    companyId: ctx.company.id,
  });
  const canEdit = can(role, 'company.edit');

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <section>
        <h1 className="mb-1 text-xl font-semibold">Сметкоплан — {ctx.company.name}</h1>
        <p className="mb-4 text-sm text-fg-muted">
          Шаблонът и вносът на сметкоплана идват с данните от пилотната кантора. Засега сметките се
          добавят ръчно. Отметнатата аналитичност е задължителна при осчетоводяване по сметката (за
          статиите оттук нататък).
        </p>
        {accounts.length === 0 ? (
          <EmptyState
            title="Още няма сметки"
            next={
              canEdit
                ? 'Добавете сметките, по които ще осчетоводявате, с формата вдясно.'
                : 'Главният счетоводител добавя сметките.'
            }
          />
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
                <th className="w-28 px-2 py-1 font-normal">Код</th>
                <th className="px-2 py-1 font-normal">Наименование</th>
                <th className="w-40 px-2 py-1 font-normal">Вид</th>
                <th className="px-2 py-1 font-normal">Аналитичност</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-b border-line">
                  <td className="px-2 py-1 tabular-nums">{a.code}</td>
                  <td className={`px-2 py-1 ${a.isPostable ? '' : 'font-semibold'}`}>{a.name}</td>
                  <td className="px-2 py-1 text-xs text-fg-muted">
                    {a.isPostable ? 'за осчетоводяване' : 'групова'}
                    {a.isActive ? '' : ' · неактивна'}
                  </td>
                  <td className="px-2 py-1 text-xs">
                    {!a.isPostable ? null : canEdit ? (
                      <span
                        className="flex flex-wrap gap-x-3"
                        role="group"
                        aria-label={`Аналитичност на сметка ${a.code}`}
                      >
                        <AccountNeed
                          accountId={a.id}
                          need="counterparty"
                          label="контрагент"
                          checked={a.needs.counterparty}
                        />
                        <AccountNeed
                          accountId={a.id}
                          need="document"
                          label="документ"
                          checked={a.needs.document}
                        />
                        <AccountNeed
                          accountId={a.id}
                          need="cost_object"
                          label="обект"
                          checked={a.needs.costObject}
                        />
                        <AccountNeed
                          accountId={a.id}
                          need="currency"
                          label="валутна"
                          checked={a.isCurrency}
                        />
                      </span>
                    ) : (
                      [
                        a.needs.counterparty && 'контрагент',
                        a.needs.document && 'документ',
                        a.needs.costObject && 'обект',
                        a.isCurrency && 'валутна',
                      ]
                        .filter(Boolean)
                        .join(', ')
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
          <h2 className="mb-3 font-semibold">Нова сметка</h2>
          <NewAccountForm />
        </aside>
      ) : null}
    </div>
  );
}
