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
import type { AccountRow, CostObjectRow, CounterpartyRow, TemplateRow } from '@/lib/ledger-data';
import { createCounterparty } from '../../analytics-actions';
import { postEntry, saveTemplate } from '../../ledger-actions';

// hint: the side a template expects when it carries no fixed amount.
type Row = {
  accountText: string;
  accountId: string;
  debit: string;
  credit: string;
  cpText: string;
  cpId: string;
  docNo: string;
  docDateText: string;
  objText: string;
  objId: string;
  memo: string;
  hint?: 'D' | 'C';
};
const emptyRow = (): Row => ({
  accountText: '',
  accountId: '',
  debit: '',
  credit: '',
  cpText: '',
  cpId: '',
  docNo: '',
  docDateText: '',
  objText: '',
  objId: '',
  memo: '',
});

// Column indices; analytic columns are shown only when some account needs them.
const ACC = 0;
const DEB = 1;
const CRE = 2;
const CP = 3;
const DOC = 4;
const DDATE = 5;
const OBJ = 6;
const MEMO = 7;
type ComboCol = typeof ACC | typeof CP | typeof OBJ;
type Option = { id: string; label: string; sub?: string; create?: true };

function amountOf(text: string): Decimal | null {
  if (!text.trim()) return new Decimal(0);
  const r = parseAmount(text);
  return r.ok ? new Decimal(r.value) : null;
}

const cpLabel = (c: Pick<CounterpartyRow, 'name' | 'eik'>) =>
  c.eik ? `${c.name} (${c.eik})` : c.name;

/**
 * Journal entry grid, keyboard first (PROMPT.md 5.2). The server validates again and the
 * database enforces Dt = Кт and the accounts' analytics on posting, so this UI is a
 * convenience, not the guarantee.
 */
export function EntryForm({
  accounts,
  templates,
  counterparties: initialCounterparties,
  costObjects,
  period,
  defaultDate,
}: {
  accounts: AccountRow[];
  templates: TemplateRow[];
  counterparties: CounterpartyRow[];
  costObjects: CostObjectRow[];
  period: PeriodContext & { label: string };
  defaultDate: string;
}) {
  const router = useRouter();
  const [dateText, setDateText] = useState(formatDate(defaultDate));
  const [dateIso, setDateIso] = useState<string | null>(defaultDate);
  const [dateError, setDateError] = useState('');
  const [description, setDescription] = useState('');
  const [rows, setRows] = useState<Row[]>([emptyRow(), emptyRow()]);
  const [suggest, setSuggest] = useState<{ row: number; col: ComboCol; index: number } | null>(
    null,
  );
  const [error, setError] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [newCp, setNewCp] = useState<{ row: number; text: string } | null>(null);
  const [counterparties, setCounterparties] = useState(initialCounterparties);
  const [note, setNote] = useState('');
  const cells = useRef<(HTMLInputElement | null)[][]>([]);

  const postable = useMemo(() => accounts.filter((a) => a.isPostable && a.isActive), [accounts]);
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const activeCps = useMemo(() => counterparties.filter((c) => c.isActive), [counterparties]);
  const activeObjs = useMemo(() => costObjects.filter((o) => o.isActive), [costObjects]);

  // Analytic columns appear only when an account of the chart needs them.
  const show = {
    cp: postable.some((a) => a.needs.counterparty),
    doc: postable.some((a) => a.needs.document),
    obj: postable.some((a) => a.needs.costObject),
  };
  const cols = [
    ACC,
    DEB,
    CRE,
    ...(show.cp ? [CP] : []),
    ...(show.doc ? [DOC, DDATE] : []),
    ...(show.obj ? [OBJ] : []),
    MEMO,
  ];

  const needsOf = (r: Row) => byId.get(r.accountId)?.needs;

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

  const isEmpty = (r: Row) =>
    !r.accountText && !r.debit && !r.credit && !r.memo && !r.cpText && !r.docNo && !r.objText;

  /** Adds the template's lines after the rows already typed; nothing typed is lost. */
  function applyTemplate(t: TemplateRow) {
    setPicker(false);
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
        ...emptyRow(),
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
      focusCell(kept.length + firstHint, added[firstHint]?.hint === 'C' ? CRE : DEB);
    } else {
      focusCell(kept.length, DEB);
    }
  }

  function update(row: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, i) => (i === row ? { ...r, ...patch } : r)));
  }

  function rank<T>(
    items: readonly T[],
    text: string,
    key: (x: T) => string,
    exact: (x: T) => boolean,
  ) {
    const q = text.trim();
    if (!q) return [];
    return items
      .map((x) => ({ x, s: exact(x) ? 1000 : matchScore(key(x), q) }))
      .filter((v) => v.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 6)
      .map((v) => v.x);
  }

  function optionsFor(row: number, col: ComboCol): Option[] {
    const r = rows[row];
    if (!r) return [];
    if (col === ACC) {
      return rank(
        [...postable].sort((a, b) => a.code.localeCompare(b.code, 'bg', { numeric: true })),
        r.accountText,
        (a) => `${a.code} ${a.name}`,
        (a) => a.code === r.accountText.trim(),
      ).map((a) => ({ id: a.id, label: a.code, sub: a.name }));
    }
    if (col === CP) {
      const q = r.cpText.trim();
      if (!q) return [];
      const found = rank(
        activeCps,
        q,
        (c) => `${c.name} ${c.eik ?? ''} ${c.vatNumber ?? ''}`,
        (c) => c.eik === q.replace(/\s+/g, ''),
      ).map((c) => ({ id: c.id, label: c.name, ...(c.eik ? { sub: c.eik } : {}) }));
      return [...found, { id: 'new', label: `Нов контрагент „${q}“…`, create: true }];
    }
    return rank(
      activeObjs,
      r.objText,
      (o) => `${o.code} ${o.name}`,
      (o) => o.code === r.objText.trim(),
    ).map((o) => ({ id: o.id, label: o.code, sub: o.name }));
  }

  /** The next column of this row worth stopping at: analytics only where needed or filled. */
  function nextCol(row: number, col: number): number | null {
    const r = rows[row];
    const needs = r ? needsOf(r) : undefined;
    for (const c of cols.filter((x) => x > col)) {
      if (c === CP && !(needs?.counterparty || r?.cpText)) continue;
      if ((c === DOC || c === DDATE) && !(needs?.document || r?.docNo)) continue;
      if (c === OBJ && !(needs?.costObject || r?.objText)) continue;
      return c;
    }
    return null;
  }

  function nextCell(row: number, col: number) {
    const c = nextCol(row, col);
    if (c !== null) return focusCell(row, c);
    if (row === rows.length - 1) setRows((rs) => [...rs, emptyRow()]);
    focusCell(row + 1, ACC);
  }

  function pick(row: number, col: ComboCol, o: Option) {
    setSuggest(null);
    if (o.create) {
      setNewCp({ row, text: rows[row]?.cpText ?? '' });
      return;
    }
    if (col === ACC) {
      const a = byId.get(o.id);
      update(row, { accountId: o.id, accountText: a ? `${a.code} ${a.name}` : o.label });
      return focusCell(row, DEB);
    }
    if (col === CP) {
      const c = counterparties.find((x) => x.id === o.id);
      update(row, { cpId: o.id, cpText: c ? cpLabel(c) : o.label });
    } else {
      const ob = costObjects.find((x) => x.id === o.id);
      update(row, { objId: o.id, objText: ob ? `${ob.code} ${ob.name}` : o.label });
    }
    nextCell(row, col);
  }

  function onCellKey(e: KeyboardEvent<HTMLInputElement>, row: number, col: number) {
    const combo = col === ACC || col === CP || col === OBJ;
    const open = combo && suggest?.row === row && suggest.col === col ? optionsFor(row, col) : [];
    if (combo && open.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const max = open.length - 1;
        const i = (suggest?.index ?? 0) + (e.key === 'ArrowDown' ? 1 : -1);
        setSuggest({ row, col, index: Math.max(0, Math.min(max, i)) });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const chosen = open[suggest?.index ?? 0] ?? open[0];
        if (chosen) pick(row, col, chosen);
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
    if (e.key === 'F9' && (col === DEB || col === CRE)) {
      // Fill the amount that balances the entry into this cell.
      e.preventDefault();
      const r = rows[row];
      if (!r) return;
      const own = amountOf(col === DEB ? r.debit : r.credit) ?? new Decimal(0);
      const need = col === DEB ? totals.diff.negated().plus(own) : totals.diff.plus(own);
      if (need.isPositive() && !need.isZero()) {
        update(
          row,
          col === DEB
            ? { debit: formatAmount(need), credit: '' }
            : { credit: formatAmount(need), debit: '' },
        );
      }
      return;
    }
    if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey && col === MEMO)) {
      e.preventDefault();
      if (col === DDATE) commitDocDate(row);
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

  const docDateIso = (text: string): string | null | undefined => {
    if (!text.trim()) return null;
    const r = parseQuickDate(text, period);
    return r.ok ? r.value : undefined; // undefined = invalid
  };
  function commitDocDate(row: number) {
    const iso = docDateIso(rows[row]?.docDateText ?? '');
    if (iso) update(row, { docDateText: formatDate(iso) });
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
    const filled = rows.filter((r) => !isEmpty(r));
    const at = (r: Row) => rows.indexOf(r);
    const check: [(r: Row) => boolean, string, number][] = [
      [(r) => !r.accountId, 'изберете сметка от списъка (по код или име).', ACC],
      [(r) => !!r.cpText && !r.cpId, 'изберете контрагент от списъка или създайте нов.', CP],
      [(r) => !!r.objText && !r.objId, 'изберете обект от списъка.', OBJ],
      [(r) => docDateIso(r.docDateText) === undefined, 'невалидна дата на документа.', DDATE],
    ];
    for (const [bad, msg, col] of check) {
      const i = filled.findIndex(bad);
      const target = filled[i];
      if (target) {
        setError(`Ред ${i + 1}: ${msg}`);
        focusCell(at(target), col);
        return;
      }
    }
    setBusy(true);
    const r = await postEntry({
      date: dateIso,
      description,
      lines: filled.map((x) => ({
        accountId: x.accountId,
        accountCode: byId.get(x.accountId)?.code ?? '',
        debit: x.debit,
        credit: x.credit,
        description: x.memo,
        counterpartyId: x.cpId,
        documentNumber: x.docNo.trim(),
        documentDate: docDateIso(x.docDateText) ?? '',
        costObjectId: x.objId,
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
    focusCell(0, ACC);
  }

  const balanced = !totals.invalid && totals.diff.isZero() && !totals.d.isZero();

  const ref = (row: number, col: number) => (el: HTMLInputElement | null) => {
    (cells.current[row] ??= [])[col] = el;
  };

  /** Account, counterparty and object cells: type, pick from the list. */
  function comboCell(
    i: number,
    col: ComboCol,
    label: string,
    value: string,
    resolved: boolean,
    onType: (text: string) => void,
    required: boolean,
  ) {
    const open = suggest?.row === i && suggest.col === col ? optionsFor(i, col) : [];
    const bad = value && !resolved && !(suggest?.row === i && suggest.col === col);
    const listId = `options-${i}-${col}`;
    return (
      <td className="relative px-1 py-1">
        <input
          ref={ref(i, col)}
          aria-label={`Ред ${i + 1}, ${label}`}
          aria-invalid={bad ? true : undefined}
          aria-required={required || undefined}
          placeholder={required && !value ? 'задължително' : undefined}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open.length > 0}
          {...(open.length > 0
            ? {
                'aria-controls': listId,
                'aria-activedescendant': `${listId}-${suggest?.index ?? 0}`,
              }
            : {})}
          className={`${inputClass} w-full`}
          value={value}
          onChange={(e) => {
            onType(e.target.value);
            setSuggest({ row: i, col, index: 0 });
          }}
          onFocus={() => value && !resolved && setSuggest({ row: i, col, index: 0 })}
          onBlur={() =>
            setTimeout(() => setSuggest((s) => (s?.row === i && s.col === col ? null : s)), 150)
          }
          onKeyDown={(e) => onCellKey(e, i, col)}
        />
        {open.length > 0 ? (
          <ul
            id={listId}
            role="listbox"
            className="absolute z-20 mt-1 w-full min-w-56 rounded border border-line-strong bg-surface-raised shadow-lg"
          >
            {open.map((o, k) => (
              <li
                key={o.id}
                id={`${listId}-${k}`}
                role="option"
                aria-selected={k === (suggest?.index ?? 0)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(i, col, o);
                }}
                className={`cursor-default px-2 py-1 aria-selected:bg-surface-selected ${o.create ? 'border-t border-line text-accent' : ''}`}
              >
                <span className="tabular-nums">{o.label}</span>
                {o.sub ? <span className="text-fg-muted"> {o.sub}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </td>
    );
  }

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
                focusCell(0, ACC);
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
                focusCell(0, ACC);
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
            <th className="w-32 px-1 py-1 text-right font-normal">Дебит</th>
            <th className="w-32 px-1 py-1 text-right font-normal">Кредит</th>
            {show.cp ? <th className="px-1 py-1 font-normal">Контрагент</th> : null}
            {show.doc ? (
              <>
                <th className="w-28 px-1 py-1 font-normal">Документ №</th>
                <th className="w-28 px-1 py-1 font-normal">Дата на док.</th>
              </>
            ) : null}
            {show.obj ? <th className="w-40 px-1 py-1 font-normal">Обект</th> : null}
            <th className="px-1 py-1 font-normal">Пояснение</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const needs = needsOf(r);
            const badDocDate = docDateIso(r.docDateText) === undefined;
            return (
              <tr key={i} className="border-b border-line align-top">
                <td className="px-1 py-1 text-right text-xs text-fg-muted tabular-nums">{i + 1}</td>
                {comboCell(
                  i,
                  ACC,
                  'сметка',
                  r.accountText,
                  !!r.accountId,
                  (t) => update(i, { accountText: t, accountId: '' }),
                  false,
                )}
                {(['debit', 'credit'] as const).map((f) => {
                  const col = f === 'debit' ? DEB : CRE;
                  return (
                    <td key={f} className="px-1 py-1">
                      <input
                        ref={ref(i, col)}
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
                        onKeyDown={(e) => onCellKey(e, i, col)}
                      />
                    </td>
                  );
                })}
                {show.cp
                  ? comboCell(
                      i,
                      CP,
                      'контрагент',
                      r.cpText,
                      !!r.cpId,
                      (t) => update(i, { cpText: t, cpId: '' }),
                      !!needs?.counterparty,
                    )
                  : null}
                {show.doc ? (
                  <>
                    <td className="px-1 py-1">
                      <input
                        ref={ref(i, DOC)}
                        aria-label={`Ред ${i + 1}, номер на документ`}
                        aria-required={needs?.document || undefined}
                        placeholder={needs?.document && !r.docNo ? 'задължително' : undefined}
                        maxLength={50}
                        className={`${inputClass} w-full`}
                        value={r.docNo}
                        onChange={(e) => update(i, { docNo: e.target.value })}
                        onKeyDown={(e) => onCellKey(e, i, DOC)}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input
                        ref={ref(i, DDATE)}
                        aria-label={`Ред ${i + 1}, дата на документ`}
                        aria-invalid={badDocDate ? true : undefined}
                        className={`${inputClass} w-full tabular-nums`}
                        value={r.docDateText}
                        onChange={(e) => update(i, { docDateText: e.target.value })}
                        onBlur={() => commitDocDate(i)}
                        onKeyDown={(e) => onCellKey(e, i, DDATE)}
                      />
                    </td>
                  </>
                ) : null}
                {show.obj
                  ? comboCell(
                      i,
                      OBJ,
                      'обект',
                      r.objText,
                      !!r.objId,
                      (t) => update(i, { objText: t, objId: '' }),
                      !!needs?.costObject,
                    )
                  : null}
                <td className="px-1 py-1">
                  <input
                    ref={ref(i, MEMO)}
                    aria-label={`Ред ${i + 1}, пояснение`}
                    className={`${inputClass} w-full`}
                    value={r.memo}
                    onChange={(e) => update(i, { memo: e.target.value })}
                    onKeyDown={(e) => onCellKey(e, i, MEMO)}
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
            <td
              className="px-2 py-2"
              role="status"
              data-testid="balance-status"
              colSpan={cols.length - 3}
            >
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
      <NewCounterpartyDialog
        prefill={newCp?.text ?? null}
        onClose={() => {
          const row = newCp?.row ?? 0;
          setNewCp(null);
          focusCell(row, CP);
        }}
        onCreated={(c) => {
          const row = newCp?.row ?? 0;
          const full: CounterpartyRow = {
            id: c.id,
            name: c.name,
            eik: c.eik,
            vatNumber: null,
            country: 'BG',
            address: '',
            isActive: true,
          };
          setCounterparties((cs) => [...cs, full]);
          update(row, { cpId: c.id, cpText: cpLabel(full) });
          setNewCp(null);
          setNote(`Контрагентът „${c.name}“ е създаден.`);
          nextCell(row, CP);
        }}
      />
    </div>
  );
}

/**
 * New counterparty without leaving the entry: digits typed in the cell become the EIK,
 * anything else the name. Enter saves, Esc returns to the cell.
 */
function NewCounterpartyDialog({
  prefill,
  onClose,
  onCreated,
}: {
  prefill: string | null;
  onClose: () => void;
  onCreated: (c: { id: string; name: string; eik: string | null }) => void;
}) {
  const [name, setName] = useState('');
  const [eik, setEik] = useState('');
  const [vat, setVat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Fill the form each time the dialog opens: digits typed in the cell are the EIK,
  // anything else the name. (Not onOpenAutoFocus: autoFocus on the name field keeps
  // Radix from firing it.)
  useEffect(() => {
    if (prefill === null) return;
    const t = prefill.trim();
    const digits = /^[\d\s]+$/.test(t);
    setName(digits ? '' : t);
    setEik(digits ? t.replace(/\s+/g, '') : '');
    setVat('');
    setError('');
  }, [prefill]);
  const field = 'flex flex-col gap-1 text-xs text-fg-muted';
  return (
    <RD.Root open={prefill !== null} onOpenChange={(o) => !o && onClose()}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-overlay" />
        <RD.Content
          className="fixed top-24 left-1/2 z-50 w-[30rem] max-w-[92vw] -translate-x-1/2 rounded border border-line-strong bg-surface-raised p-4 text-fg shadow-lg"
          // The grid decides where the cursor goes next (the next cell, or back to the cell).
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <RD.Title className="mb-1 font-semibold">Нов контрагент</RD.Title>
          <RD.Description className="mb-3 text-sm text-fg-muted">
            ЕИК се проверява засега само за брой цифри (9 или 13).
          </RD.Description>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              void createCounterparty({ name, eik, vatNumber: vat, address: '' }).then((r) => {
                setBusy(false);
                if (r.error !== undefined) setError(r.error);
                else onCreated(r);
              });
            }}
          >
            <label className={field}>
              Наименование
              <input
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={200}
                autoFocus
              />
            </label>
            <label className={field}>
              ЕИК
              <input
                className={`${inputClass} tabular-nums`}
                value={eik}
                onChange={(e) => setEik(e.target.value)}
                inputMode="numeric"
                maxLength={20}
              />
            </label>
            <label className={field}>
              ДДС номер
              <input
                className={inputClass}
                value={vat}
                onChange={(e) => setVat(e.target.value)}
                maxLength={20}
              />
            </label>
            {error ? (
              <p role="alert" className="text-sm text-negative">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <RD.Close asChild>
                <Button inline variant="secondary" type="button">
                  Отказ
                </Button>
              </RD.Close>
              <Button inline type="submit" disabled={busy}>
                {busy ? 'Запис…' : 'Създай'}
              </Button>
            </div>
          </form>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
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
