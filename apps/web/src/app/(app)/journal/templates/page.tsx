import { can, formatAmount, isRole } from '@kantora/domain';
import Link from 'next/link';
import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { loadAccounts, loadTemplates } from '@/lib/ledger-data';
import { DeleteTemplateButton } from './DeleteTemplateButton';

/** Entry templates of the company: what each one fills in, and deletion. */
export default async function TemplatesPage() {
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
  const [templates, accounts] = await Promise.all([loadTemplates(tenant), loadAccounts(tenant)]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const canEdit = can(role, 'accounting.post');

  return (
    <div className="max-w-4xl">
      <p className="mb-2 text-sm">
        <Link href="/journal" className="text-accent underline">
          ← Статии
        </Link>
      </p>
      <h1 className="mb-1 text-xl font-semibold">Шаблони на статии — {ctx.company.name}</h1>
      <p className="mb-4 text-sm text-fg-muted">
        Шаблон се създава от „Нова статия“ с „Запази като шаблон…“ и се зарежда там с F4.
      </p>
      {templates.length === 0 ? (
        <EmptyState
          title="Още няма шаблони"
          next="Попълнете статия и я запазете като шаблон."
          shortcut="F2"
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {templates.map((t) => (
            <li key={t.id} className="rounded border border-line p-3">
              <div className="mb-2 flex items-center gap-3">
                <h2 className="font-semibold">{t.name}</h2>
                {t.description && t.description !== t.name ? (
                  <span className="text-sm text-fg-muted">{t.description}</span>
                ) : null}
                {canEdit ? (
                  <span className="ml-auto">
                    <DeleteTemplateButton id={t.id} name={t.name} />
                  </span>
                ) : null}
              </div>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-fg-muted">
                    <th className="px-2 py-1 font-normal">Сметка</th>
                    <th className="w-32 px-2 py-1 text-right font-normal">Дебит</th>
                    <th className="w-32 px-2 py-1 text-right font-normal">Кредит</th>
                    <th className="px-2 py-1 font-normal">Пояснение</th>
                  </tr>
                </thead>
                <tbody>
                  {t.lines.map((l, i) => {
                    const a = byId.get(l.accountId);
                    const amount = l.amount ? formatAmount(l.amount) : 'въвежда се';
                    return (
                      <tr key={i} className="border-b border-line">
                        <td className="px-2 py-1">
                          <span className="tabular-nums">{a?.code}</span> {a?.name}
                          {a && !a.isActive ? (
                            <span className="text-warning"> (неактивна)</span>
                          ) : null}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {l.side === 'D' ? amount : ''}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {l.side === 'C' ? amount : ''}
                        </td>
                        <td className="px-2 py-1">{l.description}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
