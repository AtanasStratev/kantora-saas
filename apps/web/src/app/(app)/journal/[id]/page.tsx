import { can, formatAmount, formatDate, isRole } from '@kantora/domain';
import { withTenant } from '@kantora/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Badge, EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { appPool } from '@/lib/db';
import { ReverseButton } from './ReverseButton';

export default async function EntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const ctx = await getAppContext();
  const role = ctx.office?.role;
  if (!ctx.office || !ctx.company || !isRole(role) || !can(role, 'accounting.view')) {
    return (
      <EmptyState
        title="Нямате достъп до тази статия"
        next="Изберете фирмата, към която принадлежи."
      />
    );
  }
  const tenant = { userId: ctx.user.id, officeId: ctx.office.id, companyId: ctx.company.id };
  const data = await withTenant(appPool, tenant, async (c) => {
    const e = await c.query<{
      number: number;
      entry_date: string;
      description: string;
      locked: boolean;
      reverses_entry_id: string | null;
      reversed_by: string | null;
      posted_by: string;
      posted_at: Date;
    }>(
      `SELECT e.number, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.description,
              p.locked_at IS NOT NULL AS locked, e.reverses_entry_id, r.id AS reversed_by,
              u.full_name AS posted_by, e.posted_at
       FROM app.journal_entry e JOIN app.period p ON p.id = e.period_id
       LEFT JOIN app.journal_entry r ON r.reverses_entry_id = e.id
       LEFT JOIN app.users u ON u.id = e.posted_by
       WHERE e.id = $1 AND e.status = 'posted'`,
      [id],
    );
    const lines = await c.query<{
      line_no: number;
      code: string;
      name: string;
      side: 'D' | 'C';
      amount: string;
      description: string;
    }>(
      `SELECT l.line_no, a.code, a.name, l.side, l.amount::text, l.description
       FROM app.journal_line l JOIN app.account a ON a.id = l.account_id
       WHERE l.entry_id = $1 ORDER BY l.line_no`,
      [id],
    );
    return { entry: e.rows[0], lines: lines.rows };
  });
  // RLS returns nothing for entries of other companies/offices: same answer as "not found".
  if (!data.entry) notFound();
  const e = data.entry;
  const canReverse = can(role, 'accounting.post') && !e.reverses_entry_id && !e.reversed_by;

  return (
    <div className="max-w-4xl">
      <p className="mb-2 text-sm">
        <Link href="/journal" className="text-accent underline">
          ← Статии
        </Link>
      </p>
      <h1 className="mb-1 flex items-center gap-3 text-xl font-semibold">
        Статия № {e.number} от {formatDate(e.entry_date)}
        {e.reverses_entry_id ? (
          <Badge kind="warning">Сторно</Badge>
        ) : e.reversed_by ? (
          <Badge kind="reversed" />
        ) : (
          <Badge kind="posted" />
        )}
        {e.locked ? <Badge kind="locked" /> : null}
      </h1>
      <p className="mb-4 text-sm text-fg-muted">
        {e.description || 'Без основание'} · осчетоводена от {e.posted_by} на{' '}
        {new Intl.DateTimeFormat('bg-BG', { dateStyle: 'short', timeStyle: 'short' }).format(
          e.posted_at,
        )}
        {e.reverses_entry_id ? (
          <>
            {' '}
            ·{' '}
            <Link className="text-accent underline" href={`/journal/${e.reverses_entry_id}`}>
              оригинална статия
            </Link>
          </>
        ) : null}
        {e.reversed_by ? (
          <>
            {' '}
            ·{' '}
            <Link className="text-accent underline" href={`/journal/${e.reversed_by}`}>
              сторно
            </Link>
          </>
        ) : null}
      </p>
      <table className="mb-4 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
            <th className="w-8 px-2 py-1 text-right font-normal">№</th>
            <th className="px-2 py-1 font-normal">Сметка</th>
            <th className="w-36 px-2 py-1 text-right font-normal">Дебит</th>
            <th className="w-36 px-2 py-1 text-right font-normal">Кредит</th>
            <th className="px-2 py-1 font-normal">Пояснение</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <tr key={l.line_no} className="border-b border-line">
              <td className="px-2 py-1 text-right text-fg-muted tabular-nums">{l.line_no}</td>
              <td className="px-2 py-1">
                <span className="tabular-nums">{l.code}</span> {l.name}
              </td>
              <td className="px-2 py-1 text-right tabular-nums">
                {l.side === 'D' ? formatAmount(l.amount) : ''}
              </td>
              <td className="px-2 py-1 text-right tabular-nums">
                {l.side === 'C' ? formatAmount(l.amount) : ''}
              </td>
              <td className="px-2 py-1">{l.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {canReverse ? (
        <ReverseButton entryId={id} number={e.number} defaultDate={e.entry_date} />
      ) : null}
    </div>
  );
}
