import { can, formatAmount, formatDate, isRole } from '@kantora/domain';
import { withTenant } from '@kantora/db';
import Decimal from 'decimal.js';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { appPool } from '@/lib/db';

type Line = {
  entry_id: string;
  number: number;
  entry_date: string;
  description: string;
  side: 'D' | 'C';
  amount: string;
  running: string;
};

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
  const m = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 12 ? n : d;
  };
  const to = m(sp.to, period.month);
  const from = Math.min(m(sp.from, period.month), to);
  const tenant = { userId: ctx.user.id, officeId: ctx.office.id, companyId: ctx.company.id };

  const data = await withTenant(appPool, tenant, async (c) => {
    const acc = await c.query<{ code: string; name: string }>(
      'SELECT code, name FROM app.account WHERE id = $1',
      [id],
    );
    const base = `FROM app.journal_line l
                  JOIN app.journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
                  JOIN app.period p ON p.id = e.period_id
                  WHERE l.account_id = $1
                    AND p.fiscal_year_id = (SELECT fiscal_year_id FROM app.period WHERE id = $2)`;
    const opening = await c.query<{ v: string }>(
      `SELECT coalesce(sum(CASE l.side WHEN 'D' THEN l.amount ELSE -l.amount END), 0)::text AS v
       ${base} AND p.month < $3`,
      [id, period.id, from],
    );
    const lines = await c.query<Line>(
      `SELECT e.id AS entry_id, e.number, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date,
              coalesce(nullif(l.description, ''), e.description) AS description, l.side, l.amount::text,
              ($5::numeric + sum(CASE l.side WHEN 'D' THEN l.amount ELSE -l.amount END)
                 OVER (ORDER BY e.entry_date, e.number, l.line_no))::text AS running
       ${base} AND p.month BETWEEN $3 AND $4
       ORDER BY e.entry_date, e.number, l.line_no`,
      [id, period.id, from, to, opening.rows[0]?.v ?? '0'],
    );
    return { account: acc.rows[0], opening: opening.rows[0]?.v ?? '0', lines: lines.rows };
  });
  if (!data.account) notFound();

  const bal = (v: string) => {
    const d = new Decimal(v);
    if (d.isZero()) return '0,00';
    return `${formatAmount(d.abs())} ${d.isPositive() ? 'Дт' : 'Кт'}`;
  };
  const closing = data.lines.at(-1)?.running ?? data.opening;

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
      <p className="mb-4 text-sm text-fg-muted">
        Начално салдо: {bal(data.opening)} · крайно салдо: {bal(closing)} · {period.ledgerCurrency}
      </p>
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
