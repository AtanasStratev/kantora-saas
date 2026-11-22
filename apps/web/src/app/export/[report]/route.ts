import { can, isRole } from '@kantora/domain';
import { z } from 'zod';
import { getAppContext } from '@/lib/context';
import { toPdf } from '@/lib/export/pdf';
import { contentDisposition, type ReportTable } from '@/lib/export/table';
import { toXlsx } from '@/lib/export/xlsx';
import { periodLabel } from '@/lib/period';
import {
  accountCard,
  accountCardTable,
  journalList,
  journalTable,
  monthRange,
  trialBalance,
  trialBalanceTable,
} from '@/lib/reports';

/**
 * Excel / PDF of what a report screen shows (phase 2 step 7). Same queries as the screens
 * (lib/reports.ts), same session, RLS and permission checks; nothing is cached.
 */
const Query = z.object({
  format: z.enum(['xlsx', 'pdf']),
  from: z.string().optional(),
  to: z.string().optional(),
  id: z.uuid().optional(),
});

const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
} as const;

const fail = (status: number, message: string) =>
  new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

export async function GET(req: Request, { params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  const q = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return fail(400, 'Невалидна заявка за износ.');
  const ctx = await getAppContext();
  const role = ctx.office?.role;
  if (!ctx.office || !ctx.company || !ctx.period) return fail(400, 'Изберете фирма и период.');
  if (!isRole(role) || !can(role, 'accounting.view')) {
    return fail(403, 'Нямате достъп до счетоводството.');
  }
  const period = ctx.period;
  const tenant = { userId: ctx.user.id, officeId: ctx.office.id, companyId: ctx.company.id };
  const { from, to } = monthRange(q.data, period.month);
  const meta = {
    company: ctx.company.name,
    year: period.year,
    from,
    to,
    currency: period.ledgerCurrency,
  };

  let table: ReportTable;
  if (report === 'trial-balance') {
    table = trialBalanceTable(await trialBalance(tenant, period.id, from, to), meta);
  } else if (report === 'account-card') {
    if (!q.data.id) return fail(400, 'Липсва сметка.');
    const card = await accountCard(tenant, q.data.id, period.id, from, to);
    if (!card.account) return fail(404, 'Сметката не е намерена.');
    table = accountCardTable(card, meta);
  } else if (report === 'journal') {
    table = journalTable(await journalList(tenant, period.id), {
      ...meta,
      month: period.month,
      label: periodLabel(period),
    });
  } else {
    return fail(404, 'Няма такава справка.');
  }

  const body = q.data.format === 'xlsx' ? toXlsx(table) : await toPdf(table, new Date());
  return new Response(body as BodyInit, {
    headers: {
      'Content-Type': MIME[q.data.format],
      'Content-Disposition': contentDisposition(table.fileName, q.data.format),
      'Cache-Control': 'no-store',
    },
  });
}
