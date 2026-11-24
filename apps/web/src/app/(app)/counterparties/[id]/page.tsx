import { can, formatAmount, formatDate, isRole } from '@kantora/domain';
import Decimal from 'decimal.js';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { EmptyState } from '@/components/ui';
import { ExportLinks } from '@/components/ExportLinks';
import { ReportRangeNav, SCREEN_ROW_LIMIT } from '@/components/ReportRangeNav';
import { getAppContext } from '@/lib/context';
import { periodLabel } from '@/lib/period';
import { counterpartyStatement, monthRange, rangeLabel } from '@/lib/reports';

const bal = (v: string) => {
  const d = new Decimal(v);
  if (d.isZero()) return '0,00';
  return `${formatAmount(d.abs())} ${d.isPositive() ? 'Дт' : 'Кт'}`;
};

/** Извлечение по контрагент: its balance on every account and the lines of the range. */
export default async function CounterpartyStatementPage({
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
  const { from, to } = monthRange(await searchParams, period.month);
  const tenant = { userId: ctx.user.id, officeId: ctx.office.id, companyId: ctx.company.id };
  const st = await counterpartyStatement(tenant, id, period.id, from, to);
  if (!st.counterparty) notFound();
  const lines = st.lines.slice(0, SCREEN_ROW_LIMIT);

  return (
    <div className="max-w-5xl">
      <p className="mb-2 text-sm">
        <Link className="text-accent underline" href="/counterparties">
          ← Контрагенти
        </Link>
      </p>
      <h1 className="mb-1 text-xl font-semibold">Извлечение — {st.counterparty.name}</h1>
      <p className="mb-3 text-sm text-fg-muted">
        {st.counterparty.eik ? `ЕИК ${st.counterparty.eik} · ` : ''}
        {st.counterparty.vat_number ? `ДДС ${st.counterparty.vat_number} · ` : ''}
        {ctx.company.name} · {rangeLabel(from, to, period.year)} · в {period.ledgerCurrency}
      </p>
      <ReportRangeNav month={period.month} monthLabel={periodLabel(period)} year={period.year}>
        {st.accounts.length > 0 ? (
          <ExportLinks report="statement" params={{ id, from, to }} />
        ) : null}
      </ReportRangeNav>
      {st.accounts.length === 0 ? (
        <EmptyState
          title="Няма осчетоводени суми с този контрагент за периода"
          next="Сменете периода с Alt+P."
        />
      ) : (
        <>
          <h2 className="mb-1 font-semibold">Салда по сметки</h2>
          <table className="mb-6 w-full border-collapse text-sm" aria-label="Салда по сметки">
            <thead>
              <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
                <th className="px-2 py-1 font-normal">Сметка</th>
                <th className="w-36 px-2 py-1 text-right font-normal">Начално салдо</th>
                <th className="w-32 px-2 py-1 text-right font-normal">Дебит</th>
                <th className="w-32 px-2 py-1 text-right font-normal">Кредит</th>
                <th className="w-36 px-2 py-1 text-right font-normal">Крайно салдо</th>
              </tr>
            </thead>
            <tbody>
              {st.accounts.map((a) => (
                <tr
                  key={a.account_id}
                  className="border-b border-line"
                  data-testid={`st-${a.code}`}
                >
                  <td className="px-2 py-1">
                    <Link
                      className="text-accent underline"
                      href={`/reports/analytic?account=${a.account_id}&by=document&from=${from}&to=${to}`}
                      title="Аналитична справка на сметката"
                    >
                      <span className="tabular-nums">{a.code}</span> {a.name}
                    </Link>
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{bal(a.opening)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatAmount(a.debit)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatAmount(a.credit)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{bal(a.closing)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2 className="mb-1 font-semibold">Движения</h2>
          {lines.length < st.lines.length ? (
            <p role="note" className="mb-2 text-sm">
              На екрана са първите {lines.length} от {st.lines.length} реда. Пълното извлечение е в
              Excel и PDF.
            </p>
          ) : null}
          <table className="w-full border-collapse text-sm" aria-label="Движения">
            <thead>
              <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
                <th className="w-28 px-2 py-1 font-normal">Дата</th>
                <th className="w-16 px-2 py-1 text-right font-normal">Статия</th>
                <th className="w-20 px-2 py-1 font-normal">Сметка</th>
                <th className="w-40 px-2 py-1 font-normal">Документ</th>
                <th className="px-2 py-1 font-normal">Основание</th>
                <th className="w-32 px-2 py-1 text-right font-normal">Дебит</th>
                <th className="w-32 px-2 py-1 text-right font-normal">Кредит</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={`${l.entry_id}-${i}`} className="border-b border-line">
                  <td className="px-2 py-1 tabular-nums">{formatDate(l.entry_date)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    <Link href={`/journal/${l.entry_id}`} className="text-accent underline">
                      {l.number}
                    </Link>
                  </td>
                  <td className="px-2 py-1 tabular-nums">{l.code}</td>
                  <td className="px-2 py-1">
                    {l.document_number
                      ? `${l.document_number}${l.document_date ? ` / ${formatDate(l.document_date)}` : ''}`
                      : ''}
                  </td>
                  <td className="px-2 py-1">{l.description}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {l.side === 'D' ? formatAmount(l.amount) : ''}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {l.side === 'C' ? formatAmount(l.amount) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
