import { can, formatAmount, isRole } from '@kantora/domain';
import { euroConversionState, withTenant } from '@kantora/db';
import Decimal from 'decimal.js';
import Link from 'next/link';
import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { appPool } from '@/lib/db';
import { loadAccounts } from '@/lib/ledger-data';
import { AddYearButton, ConversionClassSelect, ConvertForm } from './EuroForms';

const CLASS_LABEL: Record<string, string> = {
  standard: 'обикновено (чл. 12–13)',
  equity: 'собствен капитал (чл. 48, ал. 6)',
  wages: 'възнаграждения (чл. 45)',
};

const signed = (v: Decimal.Value, cur: string) => {
  const d = new Decimal(v);
  if (d.isZero()) return `0,00 ${cur}`;
  return `${formatAmount(d.abs())} ${cur} ${d.isPositive() ? 'Дт' : 'Кт'}`;
};

/**
 * Превалутиране на салдата от лева в евро (ЗВЕРБ чл. 12, 13, 45, 48; ADR-0016): every
 * position of 31.12 of the BGN year converted on its own, posted as the opening balances
 * of the EUR year; the rounding to income/expense, the equity part to equity.
 */
export default async function EuroConversionPage({
  searchParams,
}: {
  searchParams: Promise<{ posted?: string }>;
}) {
  const { posted } = await searchParams;
  const ctx = await getAppContext();
  const role = ctx.office?.role;
  if (!ctx.office || !ctx.company) {
    return <EmptyState title="Изберете фирма" next="Смяна на фирма:" shortcut="Ctrl+Shift+K" />;
  }
  if (!isRole(role) || !can(role, 'accounting.view')) {
    return (
      <EmptyState
        title="Нямате достъп до счетоводството"
        next="Обърнете се към собственика на кантората."
      />
    );
  }
  const canEdit = can(role, 'company.edit');
  const tenant = { userId: ctx.user.id, officeId: ctx.office.id, companyId: ctx.company.id };
  const [st, accounts, lastRun] = await Promise.all([
    euroConversionState(appPool, tenant),
    loadAccounts(tenant),
    withTenant(
      appPool,
      tenant,
      async (c) =>
        (
          await c.query<{ gain: string; loss: string; equity: string }>(
            `SELECT gain_account_id AS gain, loss_account_id AS loss, equity_account_id AS equity
           FROM app.euro_conversion_run ORDER BY created_at DESC LIMIT 1`,
          )
        ).rows[0],
    ),
  ]);
  const heading = (
    <>
      <p className="mb-2 text-sm">
        <Link className="text-accent underline" href="/journal">
          ← Статии
        </Link>
      </p>
      <h1 className="mb-1 text-xl font-semibold">Превалутиране на салдата от лева в евро</h1>
      <p className="mb-4 max-w-3xl text-sm text-fg-muted">
        {ctx.company.name}. Всеки актив и пасив се преизчислява поотделно (ЗВЕРБ, чл. 48, ал. 2):
        делене на 1,95583 и закръгляване до цент (чл. 12–13); възнагражденията се закръгляват нагоре
        от третия знак (чл. 45). Разликите са текущ приход или разход (ал. 4), а тези на собствения
        капитал остават в собствения капитал (ал. 6).
      </p>
    </>
  );

  if ('error' in st) {
    const eurYear = st.missingBgnYear ?? 0;
    return (
      <div className="max-w-5xl">
        {heading}
        <EmptyState
          title={st.error}
          next={
            canEdit && eurYear
              ? 'Добавете годината в лева, за да въведете или внесете нейните салда.'
              : 'Главният счетоводител добавя годините.'
          }
        />
        {canEdit && eurYear ? (
          <div className="mt-3 flex justify-center">
            <AddYearButton year={eurYear} />
          </div>
        ) : null}
      </div>
    );
  }

  // Per account: BGN closing, converted total, positions.
  const byAccount = new Map<
    string,
    { code: string; name: string; cls: string; bgn: Decimal; eur: Decimal; n: number }
  >();
  for (const p of st.positions) {
    const a = byAccount.get(p.accountId) ?? {
      code: p.accountCode,
      name: p.accountName,
      cls: p.cls,
      bgn: new Decimal(0),
      eur: new Decimal(0),
      n: 0,
    };
    a.bgn = a.bgn.plus(p.bgn);
    a.n += 1;
    byAccount.set(p.accountId, a);
  }
  for (const l of st.conversion?.lines ?? []) {
    const a = byAccount.get(l.key.accountId);
    if (a) a.eur = a.eur.plus(l.eur);
  }
  const rows = [...byAccount.entries()].sort(([, a], [, b]) =>
    a.code.localeCompare(b.code, 'bg', { numeric: true }),
  );
  const choices = accounts
    .filter((a) => a.isPostable && a.isActive && !a.isCurrency)
    .map((a) => ({ id: a.id, label: `${a.code} ${a.name}` }));
  const conv = st.conversion;

  return (
    <div className="max-w-6xl">
      {heading}
      <p className="mb-3 text-sm">
        От 31.12.{st.from.year} (лева) към 01.01.{st.to.year} (евро).
      </p>
      {st.run && posted === st.run.entryId ? (
        <p role="status" className="mb-3 text-sm text-positive">
          Салдата са превалутирани:{' '}
          <Link className="text-accent underline" href={`/journal/${st.run.entryId}`}>
            статия № {st.run.number}
          </Link>
          .
        </p>
      ) : null}
      {st.run ? (
        <p
          role="note"
          className={`mb-3 text-sm ${st.run.stale ? 'text-warning' : 'text-positive'}`}
        >
          Превалутирането е направено:{' '}
          <Link className="text-accent underline" href={`/journal/${st.run.entryId}`}>
            статия № {st.run.number}
          </Link>
          .{' '}
          {st.run.stale
            ? `Салдата на ${st.from.year} г. са се променили след това. Сторнирайте статията (F8) и превалутирайте отново.`
            : `Салдата на ${st.from.year} г. не са се променили след това.`}
        </p>
      ) : null}
      {st.blockers.map((b) => (
        <p key={b} role="alert" className="mb-2 text-sm text-negative">
          {b}
        </p>
      ))}
      {st.drafts > 0 ? (
        <p role="note" className="mb-2 text-sm text-warning">
          В {st.from.year} г. има {st.drafts} неосчетоводени чернови. Те не са в салдата.
        </p>
      ) : null}
      <p role="note" className="mb-3 text-sm text-fg-muted">
        Превалутират се всички сметки със салдо, включително приходите и разходите, ако{' '}
        {st.from.year} г. още не е приключена.
      </p>

      {rows.length === 0 ? (
        <EmptyState title={`${st.from.year} г. няма салда`} next="Няма какво да се превалутира." />
      ) : (
        <table className="mb-4 w-full border-collapse text-sm" aria-label="Салда за превалутиране">
          <thead>
            <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
              <th className="w-20 px-2 py-1 font-normal">Сметка</th>
              <th className="px-2 py-1 font-normal">Наименование</th>
              <th className="w-72 px-2 py-1 font-normal">Превалутиране</th>
              <th className="w-20 px-2 py-1 text-right font-normal">Позиции</th>
              <th className="w-44 px-2 py-1 text-right font-normal">31.12.{st.from.year}</th>
              <th className="w-44 px-2 py-1 text-right font-normal">01.01.{st.to.year}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([id, a]) => (
              <tr key={id} className="border-b border-line" data-testid={`eur-${a.code}`}>
                <td className="px-2 py-1 tabular-nums">{a.code}</td>
                <td className="px-2 py-1">{a.name}</td>
                <td className="px-2 py-1">
                  {canEdit && !st.run ? (
                    <ConversionClassSelect accountId={id} code={a.code} value={a.cls} />
                  ) : (
                    <span className="text-xs">{CLASS_LABEL[a.cls] ?? a.cls}</span>
                  )}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{a.n}</td>
                <td className="px-2 py-1 text-right tabular-nums">{signed(a.bgn, 'лв.')}</td>
                <td className="px-2 py-1 text-right tabular-nums">{signed(a.eur, 'EUR')}</td>
              </tr>
            ))}
          </tbody>
          {conv ? (
            <tfoot>
              <tr className="border-t-2 border-line-strong font-semibold">
                <td colSpan={5} className="px-2 py-1 text-right">
                  Разлики на собствения капитал
                </td>
                <td className="px-2 py-1 text-right tabular-nums" data-testid="eur-equity">
                  {signed(conv.equity, 'EUR')}
                </td>
              </tr>
              <tr className="font-semibold">
                <td colSpan={5} className="px-2 py-1 text-right">
                  Разлики към приходи (Кт) или разходи (Дт)
                </td>
                <td className="px-2 py-1 text-right tabular-nums" data-testid="eur-result">
                  {signed(conv.result, 'EUR')}
                </td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      )}

      {canEdit && conv && !st.run ? (
        <ConvertForm
          accounts={choices}
          defaults={{
            gain: lastRun?.gain ?? '',
            loss: lastRun?.loss ?? '',
            equity: lastRun?.equity ?? '',
          }}
          disabled={st.blockers.length > 0}
        />
      ) : null}
    </div>
  );
}
