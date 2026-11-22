'use client';
import {
  formatAmount,
  formatDate,
  matchScore,
  parseAmount,
  parseQuickDate,
  type PeriodContext,
} from '@kantora/domain';
import * as RD from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import Decimal from 'decimal.js';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, ErrorText, Kbd, inputClass } from '@/components/ui';
import type { AccountRow, TemplateRow } from '@/lib/ledger-data';
import { postEntry, saveTemplate } from '../../ledger-actions';

// hint: the side a template expects when it carries no fixed amount.
type Row = {
  accountText: string;
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
  hint?: 'D' | 'C';
};
const emptyRow = (): Row => ({ accountText: '', accountId: '', debit: '', credit: '', memo: '' });
const COLS = 4; // account, debit, credit, memo

function amountOf(text: string): Decimal | null {
  if (!text.trim()) return new Decimal(0);
  const r = parseAmount(text);
  return r.ok ? new Decimal(r.value) : null;
}

/**
 * Journal entry grid, keyboard first (PROMPT.md 5.2). The server validates again and the
 * database enforces Dt = Кт on posting, so this UI is a convenience, not the guarantee.
 */
export function EntryForm({
  accounts,
  templates,
  period,
  defaultDate,
}: {
  accounts: AccountRow[];
  templates: TemplateRow[];
  period: PeriodContext & { label: string };
  defaultDate: string;
}) {
  const router = useRouter();
  const [dateText, setDateText] = useState(formatDate(defaultDate));
  const [dateIso, setDateIso] = useState<string | null>(defaultDate);
  const [dateError, setDateError] = useState('');
  const [description, setDescription] = useState('');
  const [rows, setRows] = useState<Row[]>([emptyRow(), emptyRow()]);
  const [suggest, setSuggest] = useState<{ row: number; index: number } | null>(null);
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [note, setNote] = useState('');
  const cells = useRef<(HTMLInputElement | null)[][]>([]);

  const postable = useMemo(() => accounts.filter((a) => a.isPostable && a.isActive), [accounts]);

  const totals = useMemo(() => {
    let d = new Decimal(0);
    let c = new Decimal(0);
    let invalid = false;
    for (const r of rows) {
      const dv = amountOf(r.debit);
      const cv = amountOf(r.credit);
      if (!dv || !cv) invalid = true;
      else {
        d = d.plus(dv);
        c = c.plus(cv);
      }
    }
    return { d, c, diff: d.minus(c), invalid };
  }, [rows]);

  // Focus is applied after React has rendered the rows, so a row appended in the same
  // keystroke already has its inputs when we try to focus them.
  const pendingFocus = useRef<[number, number] | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const el = cells.current[target[0]]?.[target[1]];
    el?.focus();
    el?.select();
  }, [focusTick, rows]);

  function focusCell(row: number, col: number) {
    pendingFocus.current = [row, col];
    setFocusTick((t) => t + 1);
  }

  const isEmpty = (r: Row) => !r.accountText && !r.debit && !r.credit && !r.memo;

  /** Adds the template's lines after the rows already typed; nothing typed is lost. */
  function applyTemplate(t: TemplateRow) {
    setPicker(false);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const skipped: string[] = [];
    const added: Row[] = [];
    for (const l of t.lines) {
      const a = byId.get(l.accountId);
      if (!a || !a.isActive || !a.isPostable) {
        skipped.push(a ? a.code : '?');
        continue;
      }
      const amount = l.amount ? formatAmount(l.amount) : '';
      added.push({
        accountText: `${a.code} ${a.name}`,
        accountId: a.id,
        debit: l.side === 'D' ? amount : '',
        credit: l.side === 'C' ? amount : '',
        memo: l.description,
        ...(l.amount ? {} : { hint: l.side }),
      });
    }
    const kept = rows.filter((r) => !isEmpty(r));
    setRows([...kept, ...added, emptyRow()]);
    if (!description.trim()) setDescription(t.description || t.name);
    setNote(
      `Добавени са редовете от шаблона „${t.name}“.` +
        (skipped.length
          ? ` Пропуснати (неактивни или групови сметки): ${skipped.join(', ')}.`
          : ''),
    );
    // Cursor to the first amount still to be typed, else to the first added row.
    const firstHint = added.findIndex((r) => r.hint);
    if (firstHint >= 0) {
      focusCell(kept.length + firstHint, added[firstHint]?.hint === 'C' ? 2 : 1);
    } else {
      focusCell(kept.length, 1);
    }
  }

  function update(row: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, i) => (i === row ? { ...r, ...patch } : r)));
  }

  function suggestionsFor(text: string): AccountRow[] {
    const q = text.trim();
    if (!q) return [];
    return postable
      .map((a) => ({ a, s: a.code === q ? 1000 : matchScore(`${a.code} ${a.name}`, q) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s || x.a.code.localeCompare(y.a.code, 'bg', { numeric: true }))
      .slice(0, 6)
      .map((x) => x.a);
  }

  function pickAccount(row: number, a: AccountRow) {
    update(row, { accountId: a.id, accountText: `${a.code} ${a.name}` });
    setSuggest(null);
    focusCell(row, 1);
  }

  function nextCell(row: number, col: number) {
    if (col < COLS - 1) return focusCell(row, col + 1);
    if (row === rows.length - 1) setRows((rs) => [...rs, emptyRow()]);
    focusCell(row + 1, 0);
  }

  function onCellKey(e: KeyboardEvent<HTMLInputElement>, row: number, col: number) {
    const open =
      suggest?.row === row && col === 0 ? suggestionsFor(rows[row]?.accountText ?? '') : [];
    if (col === 0 && open.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const max = open.length - 1;
        const i = (suggest?.index ?? 0) + (e.key === 'ArrowDown' ? 1 : -1);
        setSuggest({ row, index: Math.max(0, Math.min(max, i)) });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const chosen = open[suggest?.index ?? 0] ?? open[0];
        if (chosen) pickAccount(row, chosen);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSuggest(null);
        return;
      }
    }
    if (e.ctrlKey && e.key === 'Enter') return; // handled once by the form wrapper
    if (e.ctrlKey && (e.key === 'd' || e.key === 'D' || e.code === 'KeyD')) {
      e.preventDefault();
      const prev = rows[row - 1];
      if (prev) update(row, { ...prev });
      return;
    }
    if (e.ctrlKey && e.key === 'Delete') {
      e.preventDefault();
      setRows((rs) => (rs.length > 1 ? rs.filter((_, i) => i !== row) : [emptyRow()]));
      focusCell(Math.max(0, row - 1), col);
      return;
    }
    if (e.key === 'F9' && (col === 1 || col === 2)) {
      // Fill the amount that balances the entry into this cell.
      e.preventDefault();
      const r = rows[row];
      if (!r) return;
      const own = amountOf(col === 1 ? r.debit : r.credit) ?? new Decimal(0);
      const need = col === 1 ? totals.diff.negated().plus(own) : totals.diff.plus(own);
      if (need.isPositive() && !need.isZero()) {
        update(
          row,
          col === 1
            ? { debit: formatAmount(need), credit: '' }
            : { credit: formatAmount(need), debit: '' },
        );
      }
      return;
    }
    if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey && col === COLS - 1)) {
      e.preventDefault();
      nextCell(row, col);
      return;
    }
    if (e.key === 'ArrowDown' && row < rows.length - 1) {
      e.preventDefault();
      focusCell(row + 1, col);
    } else if (e.key === 'ArrowUp' && row > 0) {
      e.preventDefault();
      focusCell(row - 1, col);
    }
  }

  function formatCell(row: number, field: 'debit' | 'credit') {
    const v = rows[row]?.[field] ?? '';
    if (!v.trim()) return;
    const r = parseAmount(v);
    if (r.ok) {
      update(row, {
        [field]: formatAmount(r.value),
        ...(field === 'debit' ? { credit: '' } : { debit: '' }),
      });
    }
  }

  function commitDate() {
    const r = parseQuickDate(dateText, period);
    if (r.ok) {
      setDateIso(r.value);
      setDateText(formatDate(r.value));
      setDateError('');
    } else {
      setDateIso(null);
      setDateError(r.error);
    }
  }

  async function submit() {
    setError('');
    setProblems([]);
    setDone('');
    if (!dateIso) {
      setError(dateError || 'Въведете дата.');
      return;
    }
    const filled = rows.filter((r) => r.accountText || r.debit || r.credit || r.memo);
    const unknown = filled.findIndex((r) => !r.accountId);
    if (unknown >= 0) {
      setError(`Ред ${unknown + 1}: изберете сметка от списъка (по код или име).`);
      const target = filled[unknown];
      focusCell(target ? rows.indexOf(target) : 0, 0);
      return;
    }
    setBusy(true);
    const r = await postEntry({
      date: dateIso,
      description,
      lines: filled.map((x) => ({
        accountId: x.accountId,
        accountCode: x.accountText.split(' ')[0] ?? '',
        debit: x.debit,
        credit: x.credit,
        description: x.memo,
      })),
    });
    setBusy(false);
    if (r.error !== undefined) {
      setError(r.error);
      setProblems('problems' in r && r.problems ? r.problems : []);
      return;
    }
    setDone(`Статия № ${r.number} от ${formatDate(dateIso)} е осчетоводена.`);
    setRows([emptyRow(), emptyRow()]);
    setDescription('');
    router.refresh();
    focusCell(0, 0);
  }

  const balanced = !totals.invalid && totals.diff.isZero() && !totals.d.isZero();

  return (
    <div
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === 'Enter') {
          e.preventDefault();
          void submit();
        } else if (e.key === 'F4' && !e.altKey && !e.ctrlKey) {
          e.preventDefault();
          setPicker(true);
        }
      }}
    >
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Дата ({period.label})
          <input
            className={`${inputClass} w-32 tabular-nums`}
            value={dateText}
            aria-invalid={dateError ? true : undefined}
            onChange={(e) => setDateText(e.target.value)}
            onBlur={commitDate}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitDate();
                focusCell(0, 0);
              }
            }}
            autoFocus
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs text-fg-muted">
          Основание
          <input
            className={inputClass}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                focusCell(0, 0);
              }
            }}
          />
        </label>
      </div>
      {dateError ? <p className="mb-2 text-xs text-negative">{dateError}</p> : null}

      <table className="w-full border-collapse text-sm" role="grid" aria-label="Редове на статията">
        <thead>
          <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
            <th className="w-8 px-1 py-1 text-right font-normal">№</th>
            <th className="px-1 py-1 font-normal">Сметка</th>
            <th className="w-36 px-1 py-1 text-right font-normal">Дебит</th>
            <th className="w-36 px-1 py-1 text-right font-normal">Кредит</th>
            <th className="px-1 py-1 font-normal">Пояснение</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const open = suggest?.row === i ? suggestionsFor(r.accountText) : [];
            const badAccount = r.accountText && !r.accountId && suggest?.row !== i;
            return (
              <tr key={i} className="border-b border-line align-top">
                <td className="px-1 py-1 text-right text-xs text-fg-muted tabular-nums">{i + 1}</td>
                <td className="relative px-1 py-1">
                  <input
                    ref={(el) => {
                      (cells.current[i] ??= [])[0] = el;
                    }}
                    aria-label={`Ред ${i + 1}, сметка`}
                    aria-invalid={badAccount ? true : undefined}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={open.length > 0}
                    {...(open.length > 0
                      ? {
                          'aria-controls': `account-options-${i}`,
                          'aria-activedescendant': `account-option-${i}-${suggest?.index ?? 0}`,
                        }
                      : {})}
                    className={`${inputClass} w-full`}
                    value={r.accountText}
                    onChange={(e) => {
                      update(i, { accountText: e.target.value, accountId: '' });
                      setSuggest({ row: i, index: 0 });
                    }}
                    onFocus={() =>
                      r.accountText && !r.accountId && setSuggest({ row: i, index: 0 })
                    }
                    onBlur={() =>
                      setTimeout(() => setSuggest((s) => (s?.row === i ? null : s)), 150)
                    }
                    onKeyDown={(e) => onCellKey(e, i, 0)}
                  />
                  {open.length > 0 ? (
                    <ul
                      id={`account-options-${i}`}
                      role="listbox"
                      className="absolute z-20 mt-1 w-full rounded border border-line-strong bg-surface-raised shadow-lg"
                    >
                      {open.map((a, k) => (
                        <li
                          key={a.id}
                          id={`account-option-${i}-${k}`}
                          role="option"
                          aria-selected={k === (suggest?.index ?? 0)}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            pickAccount(i, a);
                          }}
                          className="cursor-default px-2 py-1 aria-selected:bg-surface-selected"
                        >
                          <span className="tabular-nums">{a.code}</span> {a.name}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </td>
                {(['debit', 'credit'] as const).map((f, k) => (
                  <td key={f} className="px-1 py-1">
                    <input
                      ref={(el) => {
                        (cells.current[i] ??= [])[k + 1] = el;
                      }}
                      aria-label={`Ред ${i + 1}, ${f === 'debit' ? 'дебит' : 'кредит'}`}
                      inputMode="decimal"
                      placeholder={
                        r.hint === (f === 'debit' ? 'D' : 'C') && !r[f] ? 'сума' : undefined
                      }
                      aria-invalid={amountOf(r[f]) === null ? true : undefined}
                      className={`${inputClass} w-full text-right tabular-nums`}
                      value={r[f]}
                      onChange={(e) => update(i, { [f]: e.target.value })}
                      onBlur={() => formatCell(i, f)}
                      onKeyDown={(e) => onCellKey(e, i, k + 1)}
                    />
                  </td>
                ))}
                <td className="px-1 py-1">
                  <input
                    ref={(el) => {
                      (cells.current[i] ??= [])[3] = el;
                    }}
                    aria-label={`Ред ${i + 1}, пояснение`}
                    className={`${inputClass} w-full`}
                    value={r.memo}
                    onChange={(e) => update(i, { memo: e.target.value })}
                    onKeyDown={(e) => onCellKey(e, i, 3)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="text-sm">
            <td />
            <td className="px-1 py-2 text-right text-fg-muted">Общо</td>
            <td
              className="px-2 py-2 text-right font-semibold tabular-nums"
              data-testid="total-debit"
            >
              {formatAmount(totals.d)}
            </td>
            <td
              className="px-2 py-2 text-right font-semibold tabular-nums"
              data-testid="total-credit"
            >
              {formatAmount(totals.c)}
            </td>
            <td className="px-2 py-2" role="status" data-testid="balance-status">
              {totals.invalid ? (
                <span className="text-negative">Има невалидна сума</span>
              ) : balanced ? (
                <span className="text-positive">Дт = Кт</span>
              ) : totals.d.isZero() && totals.c.isZero() ? (
                <span className="text-fg-muted">Въведете суми</span>
              ) : (
                <span className="text-warning">
                  Разлика {formatAmount(totals.diff.abs())} по{' '}
                  {totals.diff.isPositive() ? 'дебита' : 'кредита'} · <Kbd>F9</Kbd> попълва
                </span>
              )}
            </td>
          </tr>
        </tfoot>
      </table>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <Button inline disabled={busy} onClick={() => void submit()}>
          {busy ? 'Осчетоводяване…' : 'Осчетоводи'} <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd>
        </Button>
        <Button inline variant="secondary" onClick={() => setPicker(true)}>
          Шаблон <Kbd>F4</Kbd>
        </Button>
        <Button inline variant="secondary" onClick={() => setSaveOpen(true)}>
          Запази като шаблон…
        </Button>
        <span className="text-xs text-fg-muted">
          <Kbd>Enter</Kbd> следваща клетка · <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> редове · <Kbd>Ctrl</Kbd>+<Kbd>D</Kbd> копира реда отгоре · <Kbd>Ctrl</Kbd>+
          <Kbd>Delete</Kbd> маха реда
        </span>
      </div>
      <div className="mt-3">
        {note ? (
          <p role="status" className="text-sm text-fg-muted">
            {note}
          </p>
        ) : null}
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
      <TemplatePicker
        open={picker}
        templates={templates}
        onClose={() => setPicker(false)}
        onPick={applyTemplate}
      />
      <SaveTemplateDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        defaultName={description}
        onSave={async (name) => {
          const r = await saveTemplate({
            name,
            description,
            rows: rows.map((x) => ({
              accountId: x.accountId,
              debit: x.debit,
              credit: x.credit,
              memo: x.memo,
            })),
          });
          if (r.error !== undefined) {
            return [r.error, ...('problems' in r && r.problems ? r.problems : [])];
          }
          setSaveOpen(false);
          setNote(`Шаблонът „${name}“ е запазен. Зарежда се с F4.`);
          router.refresh();
          return [];
        }}
      />
    </div>
  );
}

function TemplatePicker({
  open,
  templates,
  onClose,
  onPick,
}: {
  open: boolean;
  templates: TemplateRow[];
  onClose: () => void;
  onPick: (t: TemplateRow) => void;
}) {
  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      label="Шаблони на статии"
      filter={(value, search, keywords) =>
        matchScore([value, ...(keywords ?? [])].join(' '), search) / 100
      }
      overlayClassName="fixed inset-0 z-40 bg-overlay"
      contentClassName="fixed top-24 left-1/2 z-50 w-[36rem] max-w-[92vw] -translate-x-1/2 rounded border border-line-strong bg-surface-raised text-fg shadow-lg"
    >
      <Command.Input
        placeholder="Търсене на шаблон…"
        className="w-full border-b border-line bg-transparent px-3 py-2 outline-none"
      />
      <Command.List className="max-h-80 overflow-auto p-1">
        <Command.Empty className="px-3 py-2 text-sm text-fg-muted">
          {templates.length
            ? 'Няма такъв шаблон.'
            : 'Още няма шаблони. Попълнете статия и изберете „Запази като шаблон…“.'}
        </Command.Empty>
        {templates.map((t) => (
          <Command.Item
            key={t.id}
            value={`template-${t.id}`}
            keywords={[t.name, t.description]}
            onSelect={() => onPick(t)}
            className="flex cursor-default justify-between rounded px-2 py-1 text-sm data-[selected=true]:bg-surface-selected"
          >
            <span>{t.name}</span>
            <span className="text-xs text-fg-muted">{t.lines.length} реда</span>
          </Command.Item>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}

function SaveTemplateDialog({
  open,
  onClose,
  defaultName,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  defaultName: string;
  onSave: (name: string) => Promise<string[]>;
}) {
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  return (
    <RD.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-overlay" />
        <RD.Content
          className="fixed top-24 left-1/2 z-50 w-[30rem] max-w-[92vw] -translate-x-1/2 rounded border border-line-strong bg-surface-raised p-4 text-fg shadow-lg"
          onOpenAutoFocus={() => {
            setName(defaultName);
            setErrors([]);
          }}
        >
          <RD.Title className="mb-1 font-semibold">Запазване като шаблон</RD.Title>
          <RD.Description className="mb-3 text-sm text-fg-muted">
            Запазват се сметките, страните и сумите. Сума 0 означава „само страната, сумата се
            въвежда всеки път“.
          </RD.Description>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              void onSave(name.trim()).then((errs) => {
                setBusy(false);
                setErrors(errs);
              });
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Име на шаблона
              <input
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
              />
            </label>
            {errors.length ? (
              <ul role="alert" className="mt-2 list-disc pl-5 text-sm text-negative">
                {errors.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <RD.Close asChild>
                <Button inline variant="secondary" type="button">
                  Отказ
                </Button>
              </RD.Close>
              <Button inline type="submit" disabled={busy}>
                {busy ? 'Запазване…' : 'Запази'}
              </Button>
            </div>
          </form>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
