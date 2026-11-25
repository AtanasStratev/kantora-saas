'use client';
import {
  formatAmount,
  formatDate,
  lineVat,
  parseAmount,
  parseQuickDate,
  VAT_KIND_LABEL,
  vatTotals,
  type PeriodContext,
  type VatDocumentKind,
} from '@kantora/domain';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Button, ErrorText, Kbd, inputClass } from '@/components/ui';
import { saveVatDocument } from '../../vat-actions';

type Option = { id: string; label: string };
type Rate = { key: string; percent: string; from: string; to: string | null; source: string };
type Row = {
  accountId: string;
  description: string;
  net: string;
  rateKey: string;
  vat: string;
  vatEdited: boolean;
};
const emptyRow = (rateKey = ''): Row => ({
  accountId: '',
  description: '',
  net: '',
  rateKey,
  vat: '',
  vatEdited: false,
});

const money = (t: string) => {
  const r = parseAmount(t);
  return r.ok ? r.value : null;
};

/**
 * A VAT document, keyboard first: every field is reachable with Tab, the selects take
 * type-ahead (account by code, counterparty by name), Ctrl+Enter posts. The VAT of a line
 * is computed from the rate; on a purchase it may be overwritten with the supplier's
 * amount (at most one cent off, checked on the server).
 */
export function VatDocumentForm({
  accounts,
  counterparties,
  rates,
  invoices,
  period,
  defaultDate,
}: {
  accounts: Option[];
  counterparties: Option[];
  rates: Rate[];
  invoices: { id: string; direction: string; counterpartyId: string; number: string }[];
  period: PeriodContext;
  defaultDate: string;
}) {
  const router = useRouter();
  const [direction, setDirection] = useState<'purchase' | 'sale'>('purchase');
  const [kind, setKind] = useState<VatDocumentKind>('invoice');
  const [counterpartyId, setCounterpartyId] = useState('');
  const [relatedId, setRelatedId] = useState('');
  const [number, setNumber] = useState('');
  const [issueText, setIssueText] = useState(formatDate(defaultDate));
  const [taxText, setTaxText] = useState('');
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  const issue = parseQuickDate(issueText, period);
  const tax = taxText.trim() ? parseQuickDate(taxText, period) : issue;
  const taxDate = tax.ok ? tax.value : null;
  const valid = useMemo(
    () => (taxDate ? rates.filter((r) => r.from <= taxDate && (!r.to || taxDate <= r.to)) : []),
    [rates, taxDate],
  );
  const percentOf = (key: string) => valid.find((r) => r.key === key)?.percent;

  const update = (i: number, patch: Partial<Row>) =>
    setRows((rs) =>
      rs.map((r, k) => {
        if (k !== i) return r;
        const next = { ...r, ...patch };
        const net = money(next.net);
        const pct = percentOf(next.rateKey);
        if (!next.vatEdited && net && pct !== undefined) next.vat = formatAmount(lineVat(net, pct));
        return next;
      }),
    );

  const normalized = rows
    .filter((r) => r.accountId || r.net)
    .map((r) => ({ ...r, netV: money(r.net), vatV: money(r.vat) }));
  // The base adds up even before a rate is chosen; a missing VAT counts as 0 here.
  const totals = vatTotals(
    normalized.filter((r) => r.netV).map((r) => ({ net: r.netV as string, vat: r.vatV ?? '0.00' })),
  );
  const related = invoices.filter(
    (i) => i.direction === direction && i.counterpartyId === counterpartyId,
  );

  async function submit() {
    setError('');
    setProblems([]);
    setDone('');
    if (!issue.ok) return setError(`Дата на издаване: ${issue.error}`);
    if (!tax.ok) return setError(`Дата на данъчното събитие: ${tax.error}`);
    if (valid.length === 0) {
      return setError(
        `Няма въведени ставки на ДДС от официален източник за ${formatDate(tax.value)}.`,
      );
    }
    const bad = normalized.findIndex((r) => !r.netV || !r.vatV);
    if (bad >= 0) return setError(`Ред ${bad + 1}: невалидна сума.`);
    setBusy(true);
    const r = await saveVatDocument({
      direction,
      kind,
      number,
      issueDate: issue.value,
      taxEventDate: tax.value,
      counterpartyId,
      relatedId,
      lines: normalized.map((x) => ({
        accountId: x.accountId,
        description: x.description,
        net: x.netV as string,
        rateKey: x.rateKey,
        vat: x.vatV as string,
      })),
    });
    setBusy(false);
    if (r.error !== undefined) {
      setError(r.error);
      setProblems('problems' in r && r.problems ? r.problems : []);
      return;
    }
    setDone(`${VAT_KIND_LABEL[kind]} № ${number} е осчетоводен(а): статия № ${r.entryNumber}.`);
    setNumber('');
    setRows([emptyRow(rows[0]?.rateKey)]);
    router.refresh();
  }

  const field = 'flex flex-col gap-1 text-xs text-fg-muted';
  return (
    <div
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === 'Enter') {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className={field}>
          <label htmlFor="vatdoc-1">Покупка или продажба</label>
          <select
            id="vatdoc-1"
            className={inputClass}
            value={direction}
            onChange={(e) => {
              setDirection(e.target.value as 'purchase' | 'sale');
              setRelatedId('');
            }}
            autoFocus
          >
            <option value="purchase">Покупка</option>
            <option value="sale">Продажба</option>
          </select>
        </div>
        <div className={field}>
          <label htmlFor="vatdoc-2">Вид документ</label>
          <select
            id="vatdoc-2"
            className={inputClass}
            value={kind}
            onChange={(e) => setKind(e.target.value as VatDocumentKind)}
          >
            {(Object.keys(VAT_KIND_LABEL) as VatDocumentKind[]).map((k) => (
              <option key={k} value={k}>
                {VAT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div className={field}>
          <label htmlFor="vatdoc-3">Контрагент</label>
          <select
            id="vatdoc-3"
            className={inputClass}
            value={counterpartyId}
            onChange={(e) => {
              setCounterpartyId(e.target.value);
              setRelatedId('');
            }}
          >
            <option value="">— изберете —</option>
            {counterparties.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <label className={field}>
          Номер на документа
          <input
            className={inputClass}
            value={number}
            maxLength={50}
            onChange={(e) => setNumber(e.target.value)}
          />
        </label>
        <label className={field}>
          Дата на издаване
          <input
            className={`${inputClass} tabular-nums`}
            value={issueText}
            aria-invalid={issue.ok ? undefined : true}
            onChange={(e) => setIssueText(e.target.value)}
            onBlur={() => issue.ok && setIssueText(formatDate(issue.value))}
          />
        </label>
        <label className={field}>
          Дата на данъчното събитие (ако е различна)
          <input
            className={`${inputClass} tabular-nums`}
            value={taxText}
            placeholder={issue.ok ? formatDate(issue.value) : ''}
            aria-invalid={tax.ok ? undefined : true}
            onChange={(e) => setTaxText(e.target.value)}
            onBlur={() => taxText.trim() && tax.ok && setTaxText(formatDate(tax.value))}
          />
        </label>
        {kind !== 'invoice' ? (
          <div className={field}>
            <label htmlFor="vatdoc-4">Към фактура</label>
            <select
              id="vatdoc-4"
              className={inputClass}
              value={relatedId}
              onChange={(e) => setRelatedId(e.target.value)}
            >
              <option value="">— изберете —</option>
              {related.map((i) => (
                <option key={i.id} value={i.id}>
                  № {i.number}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {taxDate && valid.length === 0 ? (
        <p role="alert" className="mb-3 text-sm text-warning">
          Няма въведени ставки на ДДС от официален източник за {formatDate(taxDate)}. Ставките се
          добавят, когато текстът на ЗДДС е в програмата; дотогава документ не може да се
          осчетоводи.
        </p>
      ) : null}

      <table className="w-full border-collapse text-sm" aria-label="Редове на документа">
        <thead>
          <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
            <th className="w-8 px-1 py-1 text-right font-normal">№</th>
            <th className="px-1 py-1 font-normal">
              {direction === 'purchase' ? 'Разход или актив' : 'Приход'}
            </th>
            <th className="px-1 py-1 font-normal">Описание</th>
            <th className="w-32 px-1 py-1 text-right font-normal">Данъчна основа</th>
            <th className="w-36 px-1 py-1 font-normal">Ставка</th>
            <th className="w-28 px-1 py-1 text-right font-normal">ДДС</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line">
              <td className="px-1 py-1 text-right text-xs text-fg-muted tabular-nums">{i + 1}</td>
              <td className="px-1 py-1">
                <select
                  aria-label={`Ред ${i + 1}, сметка`}
                  className={`${inputClass} w-full`}
                  value={r.accountId}
                  onChange={(e) => update(i, { accountId: e.target.value })}
                >
                  <option value="">—</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-1 py-1">
                <input
                  aria-label={`Ред ${i + 1}, описание`}
                  className={`${inputClass} w-full`}
                  value={r.description}
                  onChange={(e) => update(i, { description: e.target.value })}
                />
              </td>
              <td className="px-1 py-1">
                <input
                  aria-label={`Ред ${i + 1}, данъчна основа`}
                  inputMode="decimal"
                  className={`${inputClass} w-full text-right tabular-nums`}
                  value={r.net}
                  aria-invalid={r.net && !money(r.net) ? true : undefined}
                  onChange={(e) => update(i, { net: e.target.value })}
                  onBlur={() => {
                    const v = money(r.net);
                    if (v) update(i, { net: formatAmount(v) });
                  }}
                />
              </td>
              <td className="px-1 py-1">
                <select
                  aria-label={`Ред ${i + 1}, ставка`}
                  className={`${inputClass} w-full`}
                  value={r.rateKey}
                  onChange={(e) => update(i, { rateKey: e.target.value })}
                >
                  <option value="">—</option>
                  {valid.map((v) => (
                    <option key={v.key} value={v.key} title={v.source}>
                      {v.percent.replace('.', ',')} %
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-1 py-1">
                <input
                  aria-label={`Ред ${i + 1}, ДДС`}
                  inputMode="decimal"
                  className={`${inputClass} w-full text-right tabular-nums`}
                  value={r.vat}
                  readOnly={direction === 'sale'}
                  aria-invalid={r.vat && !money(r.vat) ? true : undefined}
                  onChange={(e) => update(i, { vat: e.target.value, vatEdited: true })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && i === rows.length - 1) {
                      e.preventDefault();
                      setRows((rs) => [...rs, emptyRow(r.rateKey)]);
                    }
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <td colSpan={3} className="px-1 py-2 text-right">
              Общо
            </td>
            <td className="px-2 py-2 text-right tabular-nums" data-testid="vat-net">
              {formatAmount(totals.net)}
            </td>
            <td />
            <td className="px-2 py-2 text-right tabular-nums" data-testid="vat-vat">
              {formatAmount(totals.vat)}
            </td>
          </tr>
          <tr className="font-semibold">
            <td colSpan={5} className="px-1 py-1 text-right">
              Сума за плащане
            </td>
            <td className="px-2 py-1 text-right tabular-nums" data-testid="vat-gross">
              {formatAmount(totals.gross)}
            </td>
          </tr>
        </tfoot>
      </table>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <Button inline disabled={busy || valid.length === 0} onClick={() => void submit()}>
          {busy ? 'Осчетоводяване…' : 'Осчетоводи'} <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd>
        </Button>
        <span className="text-xs text-fg-muted">
          <Kbd>Tab</Kbd> следващо поле · <Kbd>Enter</Kbd> в последното ДДС добавя ред
        </span>
      </div>
      <div className="mt-3">
        {done ? (
          <p role="status" className="text-sm text-positive">
            {done}
          </p>
        ) : null}
        <ErrorText>{error}</ErrorText>
        {problems.length ? (
          <ul className="list-disc pl-5 text-sm text-negative">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
