import { bnbXmlUrl, formatAmount, formatDate, parseAmount, parseQuickDate } from '@kantora/domain';
import { EmptyState, inputClass } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { bnbDay, todaySofia, toLedgerCurrency, type Conversion } from '@/lib/fx/rates';

/**
 * Курсове на БНБ за дата (ЗСч чл. 5, ал. 1) и преизчисляване на сума в отчетната валута.
 * A plain GET form: works with Enter, the address can be bookmarked or sent to a colleague.
 */
export default async function RatesPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; amount?: string; currency?: string }>;
}) {
  const ctx = await getAppContext();
  const sp = await searchParams;
  const today = todaySofia();
  const ref = ctx.period ?? {
    year: Number(today.slice(0, 4)),
    month: Number(today.slice(5, 7)),
  };

  let date = today;
  let dateError = '';
  if (sp.date?.trim()) {
    const p = parseQuickDate(sp.date, { year: ref.year, month: ref.month, today });
    if (p.ok) date = p.value;
    else dateError = p.error;
  }
  const day = dateError ? null : await bnbDay(ctx.user.id, date);

  let conversion: Conversion | null = null;
  let amountError = '';
  let amountValue = '';
  const currency = (sp.currency ?? '').toUpperCase();
  if (day?.ok && sp.amount?.trim()) {
    const a = parseAmount(sp.amount);
    if (!a.ok) amountError = a.error;
    else amountValue = a.value;
    if (!a.ok) {
      // error shown below
    } else if (!/^[A-Z]{3}$/.test(currency)) amountError = 'Изберете валута.';
    else conversion = await toLedgerCurrency(ctx.user.id, a.value, currency, date);
  }
  const ledger = date < '2026-01-01' ? 'BGN' : 'EUR';
  const options = day?.ok
    ? [...(ledger === 'EUR' ? ['BGN'] : ['EUR']), ...day.rates.map((r) => r.currency)]
    : [];

  return (
    <div className="max-w-4xl">
      <h1 className="mb-1 text-xl font-semibold">Курсове на БНБ</h1>
      <p className="mb-4 text-sm text-fg-muted">
        Централният курс на БНБ към датата на сделката (Закон за счетоводството, чл. 5, ал. 1). До
        31.12.2025 г. курсовете са към лева, от 1.01.2026 г. към еврото.
      </p>

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Дата
          <input
            name="date"
            defaultValue={sp.date ?? formatDate(today)}
            className={`${inputClass} w-32 tabular-nums`}
            aria-invalid={dateError ? true : undefined}
            aria-describedby={dateError ? 'date-error' : undefined}
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Сума (по желание)
          <input
            name="amount"
            defaultValue={sp.amount ?? ''}
            inputMode="decimal"
            className={`${inputClass} w-36 text-right tabular-nums`}
            aria-invalid={amountError ? true : undefined}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Валута
          <select name="currency" defaultValue={currency || 'USD'} className={`${inputClass} w-28`}>
            {(options.length ? options : ['USD']).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded bg-accent px-3 py-1.5 font-medium text-accent-fg">
          Покажи
        </button>
      </form>

      {dateError ? (
        <p id="date-error" role="alert" className="mb-4 text-sm text-negative">
          {dateError}
        </p>
      ) : null}
      {amountError ? (
        <p role="alert" className="mb-4 text-sm text-negative">
          {amountError}
        </p>
      ) : null}

      {conversion ? (
        conversion.ok ? (
          <p
            role="status"
            className="mb-4 rounded border border-line p-3 text-base"
            data-testid="conversion"
          >
            <span className="font-semibold tabular-nums">
              {formatAmount(amountValue)} {currency} = {formatAmount(conversion.result)}{' '}
              {conversion.ledgerCurrency}
            </span>
            <span className="block text-sm text-fg-muted">
              {conversion.basis}
              {conversion.rateDate ? ` · курс на БНБ от ${formatDate(conversion.rateDate)}` : ''}
            </span>
          </p>
        ) : (
          <p role="alert" className="mb-4 text-sm text-negative">
            {conversion.message}
          </p>
        )
      ) : null}

      {day && !day.ok ? <EmptyState title={day.message} next="Изберете друга дата." /> : null}
      {day?.ok ? (
        <>
          <h2 className="mb-1 font-semibold">Публикация на БНБ от {formatDate(day.rateDate)}</h2>
          {day.rateDate !== day.requested ? (
            <p role="note" className="mb-2 text-sm text-warning">
              За {formatDate(day.requested)} БНБ няма публикация (почивен ден). Използва се
              последният публикуван курс, от {formatDate(day.rateDate)} (както изрично изисква ЗДДС,
              чл. 26, ал. 6).
            </p>
          ) : null}
          <p className="mb-2 text-sm">
            <a className="text-accent underline" href={bnbXmlUrl(day.rateDate)} rel="noreferrer">
              Източник: bnb.bg (XML за {formatDate(day.rateDate)})
            </a>
          </p>
          <table className="w-full border-collapse text-sm" aria-label="Курсове на БНБ">
            <thead>
              <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
                <th className="w-20 px-2 py-1 font-normal">Код</th>
                <th className="w-40 px-2 py-1 text-right font-normal">Курс</th>
                <th className="px-2 py-1 font-normal">Значение</th>
              </tr>
            </thead>
            <tbody>
              {day.rates.map((r) => (
                <tr key={r.currency} className="border-b border-line">
                  <td className="px-2 py-1 tabular-nums">{r.currency}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {r.quote.rate.replace('.', ',')}
                  </td>
                  <td className="px-2 py-1 text-fg-muted">
                    {r.quote.kind === 'per_eur'
                      ? `${r.currency} за 1 евро`
                      : `лева за ${r.quote.units} ${r.currency}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
}
