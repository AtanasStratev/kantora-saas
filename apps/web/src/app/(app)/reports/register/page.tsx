import { can, formatAmount, formatDate, isRole } from '@kantora/domain';
import Link from 'next/link';
import { EmptyState } from '@/components/ui';
import { ExportLinks } from '@/components/ExportLinks';
import { ReportRangeNav, SCREEN_ROW_LIMIT } from '@/components/ReportRangeNav';
import { getAppContext } from '@/lib/context';
import { periodLabel } from '@/lib/period';
import {
  chronologicalRegister,
  monthRange,
  NOT_RECONCILED,
  rangeLabel,
  REGISTER_RECONCILED,
  registerDescription,
  type RegisterLine,
} from '@/lib/reports';

/**
 * Хронологичен регистър (ЗСч, чл. 3, ал. 2; чл. 4, ал. 4): every line of every posted
 * entry of the range, by date and number. Its totals equal the trial balance turnover
 * (integration test).
 */
export default async function RegisterPage({
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
  const reg = await chronologicalRegister(tenant, period.id, from, to);
  const reconciled = reg.totals.d === reg.totals.c;

  // Group the lines by entry; whole entries only on screen.
  const entries: RegisterLine[][] = [];
  let lineCount = 0;
  let cut = false;
  for (const l of reg.lines) {
    const last = entries.at(-1);
    if (last && last[0]?.entry_id === l.entry_id) {
      last.push(l);
    } else {
      if (lineCount >= SCREEN_ROW_LIMIT) {
        cut = true;
        break;
      }
      entries.push([l]);
    }
    lineCount++;
  }

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Хронологичен регистър — {ctx.company.name}</h1>
      <p className="mb-3 text-sm text-fg-muted">
        {rangeLabel(from, to, period.year)} · в {period.ledgerCurrency} · {reg.entries} статии
      </p>
      <ReportRangeNav month={period.month} monthLabel={periodLabel(period)} year={period.year}>
        {reg.lines.length > 0 ? <ExportLinks report="register" params={{ from, to }} /> : null}
      </ReportRangeNav>
      {reg.lines.length === 0 ? (
        <EmptyState
          title="Няма осчетоводени статии за избрания период"
          next="Сменете периода с Alt+P или въведете статия с"
          shortcut="F2"
        />
      ) : (
        <>
          {cut ? (
            <p role="note" className="mb-2 text-sm">
              Справката е голяма: на екрана са първите {entries.length} от {reg.entries} статии.
              Пълният регистър е в Excel и PDF.
            </p>
          ) : null}
          <table className="w-full border-collapse text-sm" aria-label="Хронологичен регистър">
            <thead>
              <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
                <th className="w-28 px-2 py-1 font-normal">Дата</th>
                <th className="w-16 px-2 py-1 text-right font-normal">Статия</th>
                <th className="w-64 px-2 py-1 font-normal">Сметка</th>
                <th className="px-2 py-1 font-normal">Основание</th>
                <th className="w-32 px-2 py-1 text-right font-normal">Дебит</th>
                <th className="w-32 px-2 py-1 text-right font-normal">Кредит</th>
              </tr>
            </thead>
            {entries.map(([first, ...rest]) => {
              if (!first) return null;
              const lines = [first, ...rest];
              return (
                <tbody key={first.entry_id} className="border-b border-line-strong">
                  {lines.map((l, i) => (
                    <tr key={l.line_no} className="border-b border-line last:border-b-0">
                      {i === 0 ? (
                        <>
                          <td rowSpan={lines.length} className="px-2 py-1 align-top tabular-nums">
                            {formatDate(first.entry_date)}
                          </td>
                          <td
                            rowSpan={lines.length}
                            className="px-2 py-1 text-right align-top tabular-nums"
                          >
                            <Link
                              href={`/journal/${first.entry_id}`}
                              className="text-accent underline"
                            >
                              {first.number}
                            </Link>
                          </td>
                        </>
                      ) : null}
                      <td className="px-2 py-1">
                        <span className="tabular-nums">{l.code}</span> {l.account_name}
                      </td>
                      <td className="px-2 py-1">{registerDescription(l)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {l.side === 'D' ? formatAmount(l.amount) : ''}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {l.side === 'C' ? formatAmount(l.amount) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              );
            })}
            <tfoot>
              <tr className="border-t-2 border-line-strong font-semibold">
                <td colSpan={4} className="px-2 py-1">
                  Общо ({reg.entries} статии)
                </td>
                <td className="px-2 py-1 text-right tabular-nums" data-testid="reg-total-d">
                  {formatAmount(reg.totals.d)}
                </td>
                <td className="px-2 py-1 text-right tabular-nums" data-testid="reg-total-c">
                  {formatAmount(reg.totals.c)}
                </td>
              </tr>
            </tfoot>
          </table>
          <p
            role="status"
            className={`mt-2 text-sm ${reconciled ? 'text-positive' : 'text-negative'}`}
          >
            {reconciled ? REGISTER_RECONCILED : NOT_RECONCILED}
          </p>
        </>
      )}
    </div>
  );
}
