import { can, formatAmount, formatDate, isRole } from '@kantora/domain';
import Decimal from 'decimal.js';
import Link from 'next/link';
import { EmptyState } from '@/components/ui';
import { ExportLinks } from '@/components/ExportLinks';
import { ReportRangeNav, SCREEN_ROW_LIMIT } from '@/components/ReportRangeNav';
import { getAppContext } from '@/lib/context';
import { periodLabel } from '@/lib/period';
import {
  generalLedger,
  LEDGER_RECONCILED,
  monthRange,
  NOT_RECONCILED,
  rangeLabel,
  type LedgerAccount,
} from '@/lib/reports';

/**
 * Главна книга: the systematic register (ЗСч, чл. 16, ал. 1, т. 3). Every account of the
 * trial balance with its opening balance, its movements in the range, turnover and closing
 * balance. The integration tests reconcile it with the trial balance account by account.
 */
export default async function GeneralLedgerPage({
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
  const { from, to } = monthRange(await searchParams, period.month);
  const tenant = { userId: ctx.user.id, officeId: ctx.office.id, companyId: ctx.company.id };
  const gl = await generalLedger(tenant, period.id, from, to);
  const reconciled = gl.totals.td === gl.totals.tc;

  // Whole accounts only: a cut account would show a closing balance without its lines.
  const shown: LedgerAccount[] = [];
  let lineCount = 0;
  for (const a of gl.accounts) {
    if (shown.length > 0 && lineCount + a.lines.length > SCREEN_ROW_LIMIT) break;
    shown.push(a);
    lineCount += a.lines.length;
  }
  const bal = (v: string) => {
    const d = new Decimal(v);
    if (d.isZero()) return '0,00';
    return `${formatAmount(d.abs())} ${d.isPositive() ? 'Дт' : 'Кт'}`;
  };
  const range = `?from=${from}&to=${to}`;

  return (
    <div className="max-w-5xl">
      <h1 className="mb-1 text-xl font-semibold">Главна книга — {ctx.company.name}</h1>
      <p className="mb-3 text-sm text-fg-muted">
        {rangeLabel(from, to, period.year)} · в {period.ledgerCurrency} · началните салда са от
        началото на {period.year} г.
      </p>
      <ReportRangeNav month={period.month} monthLabel={periodLabel(period)} year={period.year}>
        {gl.accounts.length > 0 ? (
          <ExportLinks report="general-ledger" params={{ from, to }} />
        ) : null}
      </ReportRangeNav>
      {gl.accounts.length === 0 ? (
        <EmptyState
          title="Няма осчетоводени статии за избрания период"
          next="Сменете периода с Alt+P или въведете статия с"
          shortcut="F2"
        />
      ) : (
        <>
          {shown.length < gl.accounts.length ? (
            <p role="note" className="mb-2 text-sm">
              Справката е голяма: на екрана са първите {shown.length} от {gl.accounts.length}{' '}
              сметки. Пълната главна книга е в Excel и PDF.
            </p>
          ) : null}
          <table className="w-full border-collapse text-sm" aria-label="Главна книга">
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
            {shown.map((a) => (
              <tbody key={a.account_id} data-testid={`gl-${a.code}`}>
                <tr className="border-b border-line bg-surface-raised">
                  <th scope="rowgroup" colSpan={5} className="px-2 py-1 text-left font-semibold">
                    <Link
                      className="text-accent underline"
                      href={`/reports/account/${a.account_id}${range}`}
                      title="Картон на сметката"
                    >
                      <span className="tabular-nums">{a.code}</span> {a.name}
                    </Link>
                    <span className="ml-2 text-xs font-normal text-fg-muted">начално салдо</span>
                  </th>
                  <td className="px-2 py-1 text-right tabular-nums">{bal(a.opening)}</td>
                </tr>
                {a.lines.map((l, i) => (
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
                    <td />
                  </tr>
                ))}
                <tr className="border-b border-line-strong font-semibold">
                  <td colSpan={3} className="px-2 py-1 text-right text-xs text-fg-muted">
                    Обороти и крайно салдо
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatAmount(a.td)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatAmount(a.tc)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{bal(a.closing)}</td>
                </tr>
              </tbody>
            ))}
            <tfoot>
              <tr className="border-t-2 border-line-strong font-semibold">
                <td colSpan={3} className="px-2 py-1">
                  Общо обороти
                </td>
                <td className="px-2 py-1 text-right tabular-nums" data-testid="gl-total-d">
                  {formatAmount(gl.totals.td)}
                </td>
                <td className="px-2 py-1 text-right tabular-nums" data-testid="gl-total-c">
                  {formatAmount(gl.totals.tc)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
          <p
            role="status"
            className={`mt-2 text-sm ${reconciled ? 'text-positive' : 'text-negative'}`}
          >
            {reconciled ? LEDGER_RECONCILED : NOT_RECONCILED}
          </p>
        </>
      )}
    </div>
  );
}
