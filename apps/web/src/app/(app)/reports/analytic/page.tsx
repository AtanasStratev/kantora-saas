import { can, formatAmount, isRole } from '@kantora/domain';
import Decimal from 'decimal.js';
import Link from 'next/link';
import { z } from 'zod';
import { EmptyState } from '@/components/ui';
import { ExportLinks } from '@/components/ExportLinks';
import { ReportRangeNav, SCREEN_ROW_LIMIT } from '@/components/ReportRangeNav';
import { getAppContext } from '@/lib/context';
import { loadAccounts } from '@/lib/ledger-data';
import { periodLabel } from '@/lib/period';
import {
  ANALYTIC_BY,
  ANALYTIC_LABEL,
  ANALYTIC_RECONCILED,
  analyticReport,
  analyticRowLabel,
  monthRange,
  NOT_RECONCILED,
  rangeLabel,
  type AnalyticBy,
} from '@/lib/reports';

const bal = (v: string) => {
  const d = new Decimal(v);
  if (d.isZero()) return '0,00';
  return `${formatAmount(d.abs())} ${d.isPositive() ? 'Дт' : 'Кт'}`;
};

/**
 * Аналитична справка (ADR-0014): one account by counterparty, document or cost object.
 * The rows add up to the account in the trial balance; the screen compares them with the
 * account read in the same transaction, the integration test with the trial balance.
 */
export default async function AnalyticPage({
  searchParams,
}: {
  searchParams: Promise<{
    account?: string;
    by?: string;
    from?: string;
    to?: string;
    open?: string;
  }>;
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
  const tenant = { userId: ctx.user.id, officeId: ctx.office.id, companyId: ctx.company.id };
  const accounts = (await loadAccounts(tenant)).filter(
    (a) => a.needs.counterparty || a.needs.document || a.needs.costObject,
  );
  const accountId = z.uuid().safeParse(sp.account).success ? sp.account : undefined;
  const account = accounts.find((a) => a.id === accountId);
  const range = `from=${from}&to=${to}`;

  const heading = (
    <h1 className="mb-1 text-xl font-semibold">Аналитична справка — {ctx.company.name}</h1>
  );
  if (!account) {
    return (
      <div className="max-w-3xl">
        {heading}
        {accounts.length === 0 ? (
          <EmptyState
            title="Няма сметки с аналитичност"
            next="В сметкоплана (g s) отбележете кои сметки водят контрагент, документ или обект."
          />
        ) : (
          <>
            <p className="mb-3 text-sm text-fg-muted">Изберете сметка:</p>
            <ul className="flex flex-col gap-1 text-sm">
              {accounts.map((a) => {
                const by: AnalyticBy = a.needs.document
                  ? 'document'
                  : a.needs.counterparty
                    ? 'counterparty'
                    : 'cost_object';
                return (
                  <li key={a.id}>
                    <Link
                      className="text-accent underline"
                      href={`/reports/analytic?account=${a.id}&by=${by}&${range}`}
                    >
                      <span className="tabular-nums">{a.code}</span> {a.name}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    );
  }

  const allowed = ANALYTIC_BY.filter((b) =>
    b === 'cost_object'
      ? account.needs.costObject
      : account.needs.counterparty || account.needs.document,
  );
  const by: AnalyticBy = allowed.find((b) => b === sp.by) ?? allowed[0] ?? 'counterparty';
  const rep = await analyticReport(tenant, account.id, by, period.id, from, to);
  const onlyOpen = sp.open === '1';
  const rows = (onlyOpen ? rep.rows.filter((r) => r.closing !== '0.00') : rep.rows).slice(
    0,
    SCREEN_ROW_LIMIT,
  );
  const total = onlyOpen ? rep.rows.filter((r) => r.closing !== '0.00').length : rep.rows.length;
  const base = `/reports/analytic?account=${account.id}&${range}`;

  return (
    <div className="max-w-5xl">
      <p className="mb-2 text-sm">
        <Link className="text-accent underline" href={`/reports/analytic?${range}`}>
          ← Друга сметка
        </Link>
      </p>
      {heading}
      <p className="mb-3 text-sm text-fg-muted">
        Сметка <span className="tabular-nums">{account.code}</span> {account.name} ·{' '}
        {rangeLabel(from, to, period.year)} · в {period.ledgerCurrency}
      </p>
      <nav aria-label="Аналитичност" className="mb-2 flex flex-wrap gap-2 text-sm">
        {allowed.map((b) => (
          <Link
            key={b}
            className={`rounded border px-2 py-0.5 ${b === by ? 'border-accent font-semibold' : 'border-line'}`}
            aria-current={b === by ? 'page' : undefined}
            href={`${base}&by=${b}`}
          >
            {ANALYTIC_LABEL[b]}
          </Link>
        ))}
        <Link
          className={`rounded border px-2 py-0.5 ${onlyOpen ? 'border-accent font-semibold' : 'border-line'}`}
          aria-current={onlyOpen ? 'true' : undefined}
          href={`${base}&by=${by}${onlyOpen ? '' : '&open=1'}`}
        >
          {onlyOpen ? 'Всички' : 'Само с остатък'}
        </Link>
      </nav>
      <ReportRangeNav
        month={period.month}
        monthLabel={periodLabel(period)}
        year={period.year}
        keep={{ account: account.id, by, ...(onlyOpen ? { open: '1' } : {}) }}
      >
        {rep.rows.length > 0 ? (
          <ExportLinks report="analytic" params={{ id: account.id, by, from, to }} />
        ) : null}
      </ReportRangeNav>
      {rep.rows.length === 0 ? (
        <EmptyState
          title="Няма осчетоводени суми по тази сметка"
          next="Сменете периода с Alt+P или въведете статия с"
          shortcut="F2"
        />
      ) : (
        <>
          {rows.length < total ? (
            <p role="note" className="mb-2 text-sm">
              Справката е голяма: на екрана са първите {rows.length} от {total} реда. Пълната
              справка е в Excel и PDF.
            </p>
          ) : null}
          <table className="w-full border-collapse text-sm" aria-label="Аналитична справка">
            <thead>
              <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
                <th className="px-2 py-1 font-normal">
                  {by === 'cost_object'
                    ? 'Обект'
                    : by === 'document'
                      ? 'Контрагент · документ'
                      : 'Контрагент'}
                </th>
                <th className="w-36 px-2 py-1 text-right font-normal">Начално салдо</th>
                <th className="w-32 px-2 py-1 text-right font-normal">Дебит</th>
                <th className="w-32 px-2 py-1 text-right font-normal">Кредит</th>
                <th className="w-36 px-2 py-1 text-right font-normal">Крайно салдо</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const label = analyticRowLabel(r, by);
                const missing = by === 'cost_object' ? !r.cost_object_id : !r.counterparty_id;
                return (
                  <tr
                    key={`${r.counterparty_id}-${r.document_number}-${r.document_date}-${r.cost_object_id}`}
                    className="border-b border-line"
                  >
                    <td className={`px-2 py-1 ${missing ? 'text-warning' : ''}`}>
                      {r.counterparty_id && by !== 'cost_object' ? (
                        <Link
                          className="text-accent underline"
                          href={`/counterparties/${r.counterparty_id}?${range}`}
                          title="Извлечение по контрагента"
                        >
                          {label}
                        </Link>
                      ) : (
                        label
                      )}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">{bal(r.opening)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{formatAmount(r.debit)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{formatAmount(r.credit)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{bal(r.closing)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-line-strong font-semibold">
                <td className="px-2 py-1">Общо по сметката</td>
                <td className="px-2 py-1 text-right tabular-nums" data-testid="an-total-opening">
                  {bal(rep.totals.opening)}
                </td>
                <td className="px-2 py-1 text-right tabular-nums" data-testid="an-total-d">
                  {formatAmount(rep.totals.debit)}
                </td>
                <td className="px-2 py-1 text-right tabular-nums" data-testid="an-total-c">
                  {formatAmount(rep.totals.credit)}
                </td>
                <td className="px-2 py-1 text-right tabular-nums" data-testid="an-total-closing">
                  {bal(rep.totals.closing)}
                </td>
              </tr>
            </tfoot>
          </table>
          <p
            role="status"
            className={`mt-2 text-sm ${rep.reconciled ? 'text-positive' : 'text-negative'}`}
          >
            {rep.reconciled ? ANALYTIC_RECONCILED : NOT_RECONCILED}
          </p>
          {onlyOpen ? (
            <p className="mt-1 text-xs text-fg-muted">
              Общият ред е за цялата сметка, включително редовете без остатък.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
