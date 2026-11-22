import { can, formatAmount, formatDate, isRole } from '@kantora/domain';
import Decimal from 'decimal.js';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { ExportLinks } from '@/components/ExportLinks';
import { accountCard, monthRange } from '@/lib/reports';

/** Картон на сметка: the entries behind a trial balance figure, with a running balance. */
export default async function AccountCardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const ctx = await getAppContext();
  const role = ctx.office?.role;
  if (
    !ctx.office ||
    !ctx.company ||
    !ctx.period ||
    !isRole(role) ||
    !can(role, 'accounting.view')
  ) {
    return (
      <EmptyState
        title="Нямате достъп до тази сметка"
        next="Изберете фирмата, към която принадлежи."
      />
    );
  }
  const period = ctx.period;
  const sp = await searchParams;
  const { from, to } = monthRange(sp, period.month);
  const tenant = { userId: ctx.user.id, officeId: ctx.office.id, companyId: ctx.company.id };
  const data = await accountCard(tenant, id, period.id, from, to);
  if (!data.account) notFound();

  const bal = (v: string) => {
    const d = new Decimal(v);
    if (d.isZero()) return '0,00';
    return `${formatAmount(d.abs())} ${d.isPositive() ? 'Дт' : 'Кт'}`;
  };
  const closing = data.closing;

  return (
    <div className="max-w-5xl">
      <p className="mb-2 text-sm">
        <Link
          href={`/reports/trial-balance?from=${from}&to=${to}`}
          className="text-accent underline"
        >
          ← Оборотна ведомост
        </Link>
      </p>
      <h1 className="mb-1 text-xl font-semibold">
        Картон на сметка <span className="tabular-nums">{data.account.code}</span>{' '}
        {data.account.name}
      </h1>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p className="text-sm text-fg-muted">
          Начално салдо: {bal(data.opening)} · крайно салдо: {bal(closing)} ·{' '}
          {period.ledgerCurrency}
        </p>
        {data.lines.length > 0 ? (
          <span className="ml-auto">
            <ExportLinks report="account-card" params={{ id, from, to }} />
          </span>
        ) : null}
      </div>
      {data.lines.length === 0 ? (
        <EmptyState
          title="Няма движения по сметката в избрания период"
          next="Сменете периода в оборотната ведомост."
        />
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
              <th className="w-28 px-2 py-1 font-normal">Дата</th>
              <th className="w-16 px-2 py-1 text-right font-normal">Статия</th>
              <th className="px-2 py-1 font-normal">Основание</th>
              <th className="w-32 px-2 py-1 text-right font-normal">Дебит</th>
              <th className="w-32 px-2 py-1 text-right font-normal">Кредит</th>
              <th className="w-36 px-2 py-1 text-right font-normal">Салдо</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l, i) => (
              <tr key={`${l.entry_id}-${i}`} className="border-b border-line">
                <td className="px-2 py-1 tabular-nums">{formatDate(l.entry_date)}</td>
                <td className="px-2 py-1 text-right tabular-nums">
                  <Link href={`/journal/${l.entry_id}`} className="text-accent underline">
                    {l.number}
                  </Link>
                </td>
                <td className="px-2 py-1">{l.description}</td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {l.side === 'D' ? formatAmount(l.amount) : ''}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {l.side === 'C' ? formatAmount(l.amount) : ''}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{bal(l.running)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
