import { can, formatAmount, formatDate, isRole, VAT_KIND_LABEL } from '@kantora/domain';
import { vatDocuments } from '@kantora/db';
import Link from 'next/link';
import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { appPool } from '@/lib/db';
import { periodLabel } from '@/lib/period';

/**
 * Документи по ДДС за периода (по дата на данъчното събитие). Дневниците, справката-
 * декларацията и файловете за НАП идват с официалното описание на НАП (docs/phase3-plan.md).
 */
export default async function VatPage() {
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
  const tenant = { userId: ctx.user.id, officeId: ctx.office.id, companyId: ctx.company.id };
  const docs = await vatDocuments(appPool, tenant, ctx.period.id);
  const canPost = can(role, 'accounting.post');

  return (
    <div className="max-w-6xl">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Документи по ДДС — {periodLabel(ctx.period)}</h1>
        <span className="ml-auto flex items-center gap-3">
          <Link href="/vat/settings" className="text-accent underline">
            Настройки на ДДС
          </Link>
          {canPost ? (
            <Link
              href="/vat/new"
              className="rounded bg-accent px-3 py-1.5 font-medium text-accent-fg"
            >
              Нов документ
            </Link>
          ) : null}
        </span>
      </div>
      <p role="note" className="mb-3 max-w-3xl text-sm text-fg-muted">
        Дневниците, справката-декларацията и файловете за НАП ще бъдат добавени, когато официалното
        описание на файловете от НАП е в програмата.
      </p>
      {docs.length === 0 ? (
        <EmptyState
          title="Няма документи за периода"
          next={canPost ? 'Въведете документ с „Нов документ“.' : 'Счетоводителят ги въвежда.'}
        />
      ) : (
        <table className="w-full border-collapse text-sm" aria-label="Документи по ДДС">
          <thead>
            <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
              <th className="w-24 px-2 py-1 font-normal">Вид</th>
              <th className="w-36 px-2 py-1 font-normal">Документ</th>
              <th className="w-28 px-2 py-1 font-normal">Дата</th>
              <th className="px-2 py-1 font-normal">Контрагент</th>
              <th className="w-32 px-2 py-1 text-right font-normal">Основа</th>
              <th className="w-28 px-2 py-1 text-right font-normal">ДДС</th>
              <th className="w-20 px-2 py-1 text-right font-normal">Статия</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} className="border-b border-line">
                <td className="px-2 py-1">{d.direction === 'purchase' ? 'Покупка' : 'Продажба'}</td>
                <td className="px-2 py-1">
                  {VAT_KIND_LABEL[d.kind]} № {d.number}
                </td>
                <td className="px-2 py-1 tabular-nums">{formatDate(d.tax_event_date)}</td>
                <td className="px-2 py-1">{d.counterparty}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatAmount(d.net)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatAmount(d.vat)}</td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {d.entry_id ? (
                    <Link className="text-accent underline" href={`/journal/${d.entry_id}`}>
                      {d.entry_number}
                    </Link>
                  ) : (
                    '—'
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
