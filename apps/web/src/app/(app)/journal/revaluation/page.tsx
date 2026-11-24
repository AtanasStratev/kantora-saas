import { can, formatAmount, formatDate, fxRevaluation, isRole } from '@kantora/domain';
import { fxPositions, withTenant } from '@kantora/db';
import Decimal from 'decimal.js';
import Link from 'next/link';
import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { appPool } from '@/lib/db';
import { fxConverter } from '@/lib/fx/rates';
import { loadAccounts, loadCounterparties } from '@/lib/ledger-data';
import { periodLabel } from '@/lib/period';
import { RevaluationForm } from './RevaluationForm';

const signed = (v: string) => {
  const d = new Decimal(v);
  if (d.isZero()) return '0,00';
  return `${formatAmount(d.abs())} ${d.isPositive() ? 'Дт' : 'Кт'}`;
};

/**
 * Преоценка на валутните позиции към края на избрания месец (СС 21, т. 3.4–3.5, 4.2;
 * ADR-0015). Shows what will be posted; posting re-reads the positions in the same
 * transaction as the entry.
 */
export default async function RevaluationPage() {
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
  const tenant = { userId: ctx.user.id, officeId: ctx.office.id, companyId: ctx.company.id };
  const [read, accounts, counterparties, runs] = await Promise.all([
    fxPositions(appPool, tenant, period.id),
    loadAccounts(tenant),
    loadCounterparties(tenant),
    withTenant(
      appPool,
      tenant,
      async (c) =>
        (
          await c.query<{
            entry_id: string;
            number: number;
            rate_date: string;
            gain_account_id: string;
            loss_account_id: string;
            reversed: boolean;
          }>(
            `SELECT r.entry_id, e.number, to_char(r.rate_date, 'YYYY-MM-DD') AS rate_date,
                  r.gain_account_id, r.loss_account_id,
                  EXISTS (SELECT 1 FROM app.journal_entry x WHERE x.reverses_entry_id = e.id) AS reversed
           FROM app.fx_revaluation_run r JOIN app.journal_entry e ON e.id = r.entry_id
           WHERE r.period_id IN (SELECT id FROM app.period
                                 WHERE fiscal_year_id = (SELECT fiscal_year_id FROM app.period WHERE id = $1))
           ORDER BY r.rate_date DESC, e.number DESC`,
            [period.id],
          )
        ).rows,
    ),
  ]);
  if (!read) return <EmptyState title="Периодът не е намерен" next="Изберете период с Alt+P." />;
  const end = read.period.endDate;
  const heading = (
    <>
      <p className="mb-2 text-sm">
        <Link className="text-accent underline" href="/journal">
          ← Статии
        </Link>
      </p>
      <h1 className="mb-1 text-xl font-semibold">Преоценка на валутните позиции</h1>
      <p className="mb-4 text-sm text-fg-muted">
        {ctx.company.name} · към {formatDate(end)} ({periodLabel(period)}) · в{' '}
        {period.ledgerCurrency}. По заключителния курс (СС 21, т. 3.4); колко често се прави, решава
        фирмата (т. 3.5), задължително към датата на всеки финансов отчет.
      </p>
    </>
  );

  if (read.positions.length === 0) {
    return (
      <div className="max-w-5xl">
        {heading}
        <EmptyState
          title="Няма валутни позиции"
          next={
            accounts.some((a) => a.isCurrency)
              ? 'По валутните сметки няма осчетоводени суми до края на периода.'
              : 'В сметкоплана (g s) отбележете кои сметки са валутни.'
          }
        />
      </div>
    );
  }

  const fx = await fxConverter(
    ctx.user.id,
    end,
    read.positions.map((p) => p.currency),
  );
  const cpName = new Map(counterparties.map((c) => [c.id, c.name]));
  const preview = fx.ok ? fxRevaluation(read.positions, fx.convert) : null;
  const diffOf = new Map(
    (preview?.lines ?? []).map((l) => [l.position, l.side === 'D' ? l.amount : `-${l.amount}`]),
  );
  const canPost = isRole(role) && can(role, 'accounting.post') && !read.period.locked;
  const choices = accounts
    .filter((a) => a.isPostable && a.isActive && !a.isCurrency)
    .map((a) => ({ id: a.id, label: `${a.code} ${a.name}` }));
  const last = runs[0];

  return (
    <div className="max-w-6xl">
      {heading}
      {!fx.ok ? (
        <p role="alert" className="mb-3 text-sm text-negative">
          {fx.message} Преоценката може да се направи, когато курсовете за {formatDate(end)} са
          публикувани.
        </p>
      ) : (
        <p className="mb-3 text-sm text-fg-muted">
          Курсове:{' '}
          {Object.entries(fx.basis)
            .map(([c, b]) => `${c} ${b}`)
            .join(' · ')}
        </p>
      )}
      {read.withoutCurrency.length > 0 ? (
        <p role="note" className="mb-3 text-sm text-warning">
          Редове по валутни сметки без валута (осчетоводени преди сметката да е отбелязана като
          валутна) не се преоценяват:{' '}
          {read.withoutCurrency.map((w) => `${w.accountCode} (${w.lines})`).join(', ')}.
        </p>
      ) : null}
      <table className="mb-4 w-full border-collapse text-sm" aria-label="Валутни позиции">
        <thead>
          <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
            <th className="w-20 px-2 py-1 font-normal">Сметка</th>
            <th className="w-16 px-2 py-1 font-normal">Валута</th>
            <th className="px-2 py-1 font-normal">Контрагент · документ</th>
            <th className="w-36 px-2 py-1 text-right font-normal">Сума във валута</th>
            <th className="w-36 px-2 py-1 text-right font-normal">Отчетена стойност</th>
            <th className="w-36 px-2 py-1 text-right font-normal">По курса</th>
            <th className="w-32 px-2 py-1 text-right font-normal">Разлика</th>
          </tr>
        </thead>
        <tbody>
          {read.positions.map((p, i) => {
            const diff = diffOf.get(p);
            const revalued = diff
              ? new Decimal(p.ledgerBalance).plus(diff).toFixed(2)
              : p.ledgerBalance;
            return (
              <tr
                key={i}
                className="border-b border-line"
                data-testid={`fx-${p.accountCode}-${p.currency}-${i}`}
              >
                <td className="px-2 py-1 tabular-nums">{p.accountCode}</td>
                <td className="px-2 py-1">{p.currency}</td>
                <td className="px-2 py-1">
                  {[
                    p.counterpartyId ? cpName.get(p.counterpartyId) : null,
                    p.documentNumber ? `№ ${p.documentNumber}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{signed(p.currencyBalance)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{signed(p.ledgerBalance)}</td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {fx.ok ? signed(revalued) : '—'}
                </td>
                <td
                  className={`px-2 py-1 text-right tabular-nums ${diff ? (diff.startsWith('-') ? 'text-negative' : 'text-positive') : 'text-fg-muted'}`}
                >
                  {fx.ok ? (diff ? formatAmount(diff) : '0,00') : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
        {preview ? (
          <tfoot>
            <tr className="border-t-2 border-line-strong font-semibold">
              <td colSpan={6} className="px-2 py-1 text-right">
                Положителни разлики (приход)
              </td>
              <td className="px-2 py-1 text-right tabular-nums" data-testid="fx-gain">
                {formatAmount(preview.gain)}
              </td>
            </tr>
            <tr className="font-semibold">
              <td colSpan={6} className="px-2 py-1 text-right">
                Отрицателни разлики (разход)
              </td>
              <td className="px-2 py-1 text-right tabular-nums" data-testid="fx-loss">
                {formatAmount(preview.loss)}
              </td>
            </tr>
          </tfoot>
        ) : null}
      </table>

      {read.period.locked ? (
        <p className="text-sm text-fg-muted">Периодът е заключен.</p>
      ) : !canPost ? null : preview && preview.lines.length === 0 ? (
        <p role="status" className="text-sm text-positive">
          Позициите вече са по заключителния курс. Няма какво да се осчетоводи.
        </p>
      ) : preview ? (
        <RevaluationForm
          periodId={period.id}
          accounts={choices}
          defaultGain={last?.gain_account_id ?? ''}
          defaultLoss={last?.loss_account_id ?? ''}
        />
      ) : null}

      {runs.length > 0 ? (
        <section className="mt-6">
          <h2 className="mb-1 font-semibold">Преоценки през годината</h2>
          <ul className="text-sm">
            {runs.map((r) => (
              <li key={r.entry_id}>
                Към {formatDate(r.rate_date)}:{' '}
                <Link className="text-accent underline" href={`/journal/${r.entry_id}`}>
                  статия № {r.number}
                </Link>
                {r.reversed ? ' (сторнирана)' : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
