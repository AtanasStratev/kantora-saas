import { can, formatAmount, isRole } from '@kantora/domain';
import Decimal from 'decimal.js';
import Link from 'next/link';
import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { ExportLinks } from '@/components/ExportLinks';
import { periodLabel } from '@/lib/period';
import { monthRange, NOT_RECONCILED, RECONCILED, rangeLabel, trialBalance } from '@/lib/reports';

/**
 * Оборотна ведомост for months [from..to] of the selected period's fiscal year.
 * Opening = posted entries of the same fiscal year before `from` (amounts of different
 * years are in different ledger currencies and are never mixed; opening balances of a year
 * come from the carry-forward, phase 6, or the import, phase 2 step 14).
 */
export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
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
  const sp = await searchParams;
  const { from, to } = monthRange(sp, period.month);
  const year = period.year;
  const tenant = { userId: ctx.user.id, officeId: ctx.office.id, companyId: ctx.company.id };
  // Same query as the Excel/PDF export (lib/reports.ts): numeric in PostgreSQL, never float.
  const { rows, totals, reconciled } = await trialBalance(tenant, period.id, from, to);
  const fmt = (v: string) => (new Decimal(v).isZero() ? '' : formatAmount(v));
  const view = rows;
  const q = (f: number, t: number) => `?from=${f}&to=${t}`;

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Оборотна ведомост — {ctx.company.name}</h1>
      <p className="mb-3 text-sm text-fg-muted">
        {rangeLabel(from, to, year)} · в {period.ledgerCurrency} · началните салда са от началото на{' '}
        {year} г.
      </p>
      <nav aria-label="Период на справката" className="mb-4 flex flex-wrap gap-2 text-sm">
        <Link
          className="rounded border border-line px-2 py-0.5"
          href={q(period.month, period.month)}
        >
          {periodLabel(period)}
        </Link>
        <Link className="rounded border border-line px-2 py-0.5" href={q(1, period.month)}>
          От началото на годината
        </Link>
        <Link className="rounded border border-line px-2 py-0.5" href={q(1, 12)}>
          Цялата {year}
        </Link>
        {view.length > 0 ? (
          <span className="ml-auto">
            <ExportLinks report="trial-balance" params={{ from, to }} />
          </span>
        ) : null}
      </nav>
      {view.length === 0 ? (
        <EmptyState
          title="Няма осчетоводени статии за избрания период"
          next="Сменете периода с Alt+P или въведете статия с"
          shortcut="F2"
        />
      ) : (
        <table className="w-full border-collapse text-sm" aria-label="Оборотна ведомост">
          <thead className="text-xs text-fg-muted">
            <tr>
              <th
                rowSpan={2}
                className="border-b border-line-strong px-2 py-1 text-left font-normal"
              >
                Сметка
              </th>
              <th colSpan={2} className="px-2 py-1 font-normal">
                Начално салдо
              </th>
              <th colSpan={2} className="px-2 py-1 font-normal">
                Обороти
              </th>
              <th colSpan={2} className="px-2 py-1 font-normal">
                Крайно салдо
              </th>
            </tr>
            <tr className="border-b border-line-strong">
              {['Дебит', 'Кредит', 'Дебит', 'Кредит', 'Дебит', 'Кредит'].map((h, i) => (
                <th key={i} className="w-28 px-2 py-1 text-right font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.map((r) => (
              <tr key={r.account_id} className="border-b border-line">
                <td className="px-2 py-1">
                  <Link
                    className="text-accent underline"
                    href={`/reports/account/${r.account_id}${q(from, to)}`}
                    title="Картон на сметката: статиите, от които е образувана сумата"
                  >
                    <span className="tabular-nums">{r.code}</span> {r.name}
                  </Link>
                </td>
                {[r.od, r.oc, r.td, r.tc, r.cd, r.cc].map((v, i) => (
                  <td key={i} className="px-2 py-1 text-right tabular-nums">
                    {fmt(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line-strong font-semibold">
              <td className="px-2 py-1">Общо</td>
              {[totals.od, totals.oc, totals.td, totals.tc, totals.cd, totals.cc].map((v, i) => (
                <td
                  key={i}
                  className="px-2 py-1 text-right tabular-nums"
                  data-testid={`tb-total-${i}`}
                >
                  {formatAmount(v)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      )}
      {view.length > 0 ? (
        <p
          role="status"
          className={`mt-2 text-sm ${reconciled ? 'text-positive' : 'text-negative'}`}
        >
          {reconciled ? RECONCILED : NOT_RECONCILED}
        </p>
      ) : null}
    </div>
  );
}
