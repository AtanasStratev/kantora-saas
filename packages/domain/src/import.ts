/**
 * Import from the program's own Excel template (ADR-0017): sheets "Сметки", "Контрагенти",
 * "Обекти", "Начални салда" and "Статии". This module turns the cells into typed records
 * and lists every problem with its sheet and row; the database layer then resolves the
 * references (accounts, counterparties, objects) and posts everything in one transaction.
 * Pure: no files, no database.
 */
import { parseEik, parseVatNumber, type AnalyticNeeds } from './analytics';
import { postingProblems, type Side } from './journal';
import { parseAmount } from './input-format';
import { excelNumberToMoney } from './rounding';

export type ImportCell = { type: 'text' | 'number' | 'bool' | 'error'; value: string };
export type ImportSheet = { name: string; rows: (ImportCell | undefined)[][] };
export type ImportIssue = { sheet: string; row: number; message: string };

export type ImportAccount = {
  row: number;
  code: string;
  name: string;
  isPostable: boolean;
  needs: AnalyticNeeds;
  isCurrency: boolean;
  conversion: 'standard' | 'equity' | 'wages';
};
export type ImportCounterparty = {
  row: number;
  name: string;
  eik: string | null;
  vatNumber: string | null;
  country: string;
  address: string;
};
export type ImportObject = { row: number; code: string; name: string };
export type ImportLine = {
  sheet: string;
  row: number;
  account: string;
  side: Side;
  amount: string;
  /** EIK or exact name of a counterparty (of the company or of this file). */
  counterparty: string | null;
  documentNumber: string | null;
  documentDate: string | null;
  costObject: string | null;
  currency: string | null;
  currencyAmount: string | null;
  description: string;
};
export type ImportEntry = {
  key: string;
  row: number;
  date: string;
  description: string;
  lines: ImportLine[];
};
export type ParsedImport = {
  accounts: ImportAccount[];
  counterparties: ImportCounterparty[];
  objects: ImportObject[];
  opening: ImportLine[];
  entries: ImportEntry[];
  issues: ImportIssue[];
  /** Sheets that were not recognised (ignored). */
  ignored: string[];
};

/** The template: sheet names and their columns. Also used to build the empty template. */
export const IMPORT_TEMPLATE = {
  accounts: {
    sheet: 'Сметки',
    columns: [
      'Код',
      'Наименование',
      'Групова',
      'Контрагент',
      'Документ',
      'Обект',
      'Валутна',
      'Превалутиране',
    ],
    required: ['Код', 'Наименование'],
  },
  counterparties: {
    sheet: 'Контрагенти',
    columns: ['Наименование', 'ЕИК', 'ДДС номер', 'Държава', 'Адрес'],
    required: ['Наименование'],
  },
  objects: {
    sheet: 'Обекти',
    columns: ['Код', 'Наименование'],
    required: ['Код', 'Наименование'],
  },
  opening: {
    sheet: 'Начални салда',
    columns: [
      'Сметка',
      'Дебит',
      'Кредит',
      'Контрагент',
      'Документ №',
      'Дата на документа',
      'Обект',
      'Валута',
      'Сума във валута',
    ],
    required: ['Сметка'],
  },
  entries: {
    sheet: 'Статии',
    columns: [
      'Статия',
      'Дата',
      'Основание',
      'Сметка',
      'Дебит',
      'Кредит',
      'Контрагент',
      'Документ №',
      'Дата на документа',
      'Обект',
      'Валута',
      'Сума във валута',
      'Пояснение',
    ],
    required: ['Статия', 'Дата', 'Сметка'],
  },
} as const;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const SHEETS: Record<string, keyof typeof IMPORT_TEMPLATE> = {
  [norm('Сметки')]: 'accounts',
  [norm('Сметкоплан')]: 'accounts',
  [norm('Контрагенти')]: 'counterparties',
  [norm('Обекти')]: 'objects',
  [norm('Начални салда')]: 'opening',
  [norm('Статии')]: 'entries',
  [norm('Журнал')]: 'entries',
};

const text = (c: ImportCell | undefined) => (c ? c.value.trim() : '');

/** "да", "x", "1", TRUE → true; empty, "не", "0", FALSE → false; else null. */
function flag(c: ImportCell | undefined): boolean | null {
  const v = norm(text(c));
  if (v === '' || v === 'не' || v === '0' || v === 'false' || v === 'no') return false;
  if (v === 'да' || v === 'x' || v === 'х' || v === '1' || v === 'true' || v === 'yes') return true;
  return null;
}

/** A money cell: a number cell, or text in the Bulgarian format ("1 234,56"). */
function money(
  c: ImportCell | undefined,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (!c || c.value.trim() === '') return { ok: true, value: null };
  if (c.type === 'number') {
    const v = excelNumberToMoney(c.value);
    return v === null
      ? { ok: false, error: `сумата ${c.value} има повече от 2 знака след запетаята` }
      : { ok: true, value: v };
  }
  const r = parseAmount(c.value);
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error };
}

const pad = (n: number) => String(n).padStart(2, '0');
function validIso(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** A date cell: an Excel date (serial number) or text "15.11.2026" / "2026-11-15". */
function date(
  c: ImportCell | undefined,
  date1904: boolean,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (!c || c.value.trim() === '') return { ok: true, value: null };
  const v = c.value.trim();
  if (c.type === 'number') {
    const serial = Number(v);
    if (!Number.isInteger(serial) || serial < 1)
      return { ok: false, error: `неразпозната дата ${v}` };
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const d = new Date(epoch + serial * 86_400_000);
    return { ok: true, value: d.toISOString().slice(0, 10) };
  }
  const bg = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v);
  const isoText = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const iso = bg
    ? validIso(Number(bg[3]), Number(bg[2]), Number(bg[1]))
    : isoText
      ? validIso(Number(isoText[1]), Number(isoText[2]), Number(isoText[3]))
      : null;
  return iso
    ? { ok: true, value: iso }
    : { ok: false, error: `неразпозната дата „${v}“ (пример: 15.11.2026)` };
}

export function parseImportWorkbook(
  sheets: readonly ImportSheet[],
  opts: { date1904?: boolean } = {},
): ParsedImport {
  const out: ParsedImport = {
    accounts: [],
    counterparties: [],
    objects: [],
    opening: [],
    entries: [],
    issues: [],
    ignored: [],
  };
  const date1904 = opts.date1904 ?? false;
  const seen = new Set<keyof typeof IMPORT_TEMPLATE>();

  for (const sh of sheets) {
    const kind = SHEETS[norm(sh.name)];
    if (!kind) {
      out.ignored.push(sh.name);
      continue;
    }
    if (seen.has(kind)) {
      out.issues.push({ sheet: sh.name, row: 0, message: 'Листът се повтаря във файла.' });
      continue;
    }
    seen.add(kind);
    const tpl = IMPORT_TEMPLATE[kind];
    const issue = (row: number, message: string) =>
      out.issues.push({ sheet: sh.name, row, message });

    // The header is the first non-empty row; columns are found by their names.
    const headerIdx = sh.rows.findIndex((r) => r.some((c) => text(c) !== ''));
    if (headerIdx < 0) continue;
    const header = (sh.rows[headerIdx] ?? []).map((c) => norm(text(c)));
    const col = new Map<string, number>();
    for (const name of tpl.columns) {
      const i = header.indexOf(norm(name));
      if (i >= 0) col.set(name, i);
    }
    const missing = tpl.required.filter((n) => !col.has(n));
    if (missing.length) {
      issue(headerIdx + 1, `Липсват колони: ${missing.join(', ')}.`);
      continue;
    }
    const at = (r: (ImportCell | undefined)[], name: string) => {
      const i = col.get(name);
      return i === undefined ? undefined : r[i];
    };

    for (let i = headerIdx + 1; i < sh.rows.length; i++) {
      const r = sh.rows[i] ?? [];
      if (!r.some((c) => text(c) !== '')) continue;
      const rowNo = i + 1; // as Excel shows it
      const errorCell = r.find((c) => c?.type === 'error');
      if (errorCell) {
        issue(rowNo, `Клетка с грешка от Excel (${errorCell.value}).`);
        continue;
      }

      if (kind === 'accounts') {
        const code = text(at(r, 'Код'));
        const name = text(at(r, 'Наименование'));
        if (!/^[0-9A-Za-z][0-9A-Za-z./-]*$/.test(code)) {
          issue(rowNo, `Невалиден код на сметка „${code}“.`);
          continue;
        }
        if (name.length < 2) {
          issue(rowNo, 'Липсва наименование на сметката.');
          continue;
        }
        const flags = ['Групова', 'Контрагент', 'Документ', 'Обект', 'Валутна'].map((n) =>
          flag(at(r, n)),
        );
        if (flags.some((f) => f === null)) {
          issue(rowNo, 'Отметките се пишат „да“ или „не“ (или се оставят празни).');
          continue;
        }
        const conv = norm(text(at(r, 'Превалутиране')));
        const conversion =
          conv === '' || conv === 'обикновено'
            ? 'standard'
            : conv === 'капитал' || conv === 'собствен капитал'
              ? 'equity'
              : conv === 'възнаграждения'
                ? 'wages'
                : null;
        if (!conversion) {
          issue(rowNo, 'Превалутиране: „обикновено“, „капитал“ или „възнаграждения“.');
          continue;
        }
        const [group, cp, doc, obj, cur] = flags as boolean[];
        out.accounts.push({
          row: rowNo,
          code,
          name,
          isPostable: !group,
          needs: { counterparty: !!cp, document: !!doc, costObject: !!obj },
          isCurrency: !!cur,
          conversion,
        });
      } else if (kind === 'counterparties') {
        const name = text(at(r, 'Наименование'));
        if (!name) {
          issue(rowNo, 'Липсва наименование на контрагента.');
          continue;
        }
        const eik = parseEik(text(at(r, 'ЕИК')));
        const vat = parseVatNumber(text(at(r, 'ДДС номер')));
        if (!eik.ok) issue(rowNo, eik.error);
        if (!vat.ok) issue(rowNo, vat.error);
        const country = text(at(r, 'Държава')).toUpperCase() || 'BG';
        if (!/^[A-Z]{2}$/.test(country)) issue(rowNo, 'Държавата е код от 2 букви, напр. BG.');
        if (!eik.ok || !vat.ok || !/^[A-Z]{2}$/.test(country)) continue;
        out.counterparties.push({
          row: rowNo,
          name,
          eik: eik.value,
          vatNumber: vat.value,
          country,
          address: text(at(r, 'Адрес')),
        });
      } else if (kind === 'objects') {
        const code = text(at(r, 'Код'));
        const name = text(at(r, 'Наименование'));
        if (!code || !name) {
          issue(rowNo, 'Обектът има нужда от код и наименование.');
          continue;
        }
        out.objects.push({ row: rowNo, code, name });
      } else {
        // A line: opening balances or a journal entry.
        const d = money(at(r, 'Дебит'));
        const c = money(at(r, 'Кредит'));
        const dd = date(at(r, 'Дата на документа'), date1904);
        const ca = money(at(r, 'Сума във валута'));
        const errs: string[] = [];
        if (!d.ok) errs.push(`Дебит: ${d.error}`);
        if (!c.ok) errs.push(`Кредит: ${c.error}`);
        if (!dd.ok) errs.push(`Дата на документа: ${dd.error}`);
        if (!ca.ok) errs.push(`Сума във валута: ${ca.error}`);
        const account = text(at(r, 'Сметка'));
        if (!account) errs.push('липсва сметка');
        const debit = d.ok ? d.value : null;
        const credit = c.ok ? c.value : null;
        if (d.ok && c.ok && (debit === null) === (credit === null)) {
          errs.push('попълнете или дебит, или кредит');
        }
        const currency = text(at(r, 'Валута')).toUpperCase() || null;
        if (currency && !/^[A-Z]{3}$/.test(currency)) errs.push('валутата е 3 букви, напр. USD');
        if (currency && ca.ok && ca.value === null)
          errs.push('при валута въведете и сумата във валута');
        const docNo = text(at(r, 'Документ №')) || null;
        if (dd.ok && dd.value && !docNo) errs.push('дата на документ без номер');
        if (errs.length) {
          issue(
            rowNo,
            `${errs.join('; ')}.`.replace(/^./, (x) => x.toUpperCase()),
          );
          continue;
        }
        const amount = (debit ?? credit) as string;
        if (amount.startsWith('-') || /^0(\.0+)?$/.test(amount)) {
          issue(rowNo, 'Сумата трябва да е положителна.');
          continue;
        }
        const line: ImportLine = {
          sheet: sh.name,
          row: rowNo,
          account,
          side: debit !== null ? 'D' : 'C',
          amount,
          counterparty: text(at(r, 'Контрагент')) || null,
          documentNumber: docNo,
          documentDate: dd.ok ? dd.value : null,
          costObject: text(at(r, 'Обект')) || null,
          currency,
          currencyAmount: ca.ok ? ca.value : null,
          description: text(at(r, 'Пояснение')),
        };
        if (kind === 'opening') {
          out.opening.push(line);
          continue;
        }
        const key = text(at(r, 'Статия'));
        const ed = date(at(r, 'Дата'), date1904);
        if (!key) {
          issue(rowNo, 'Липсва номер на статия (редовете на една статия имат еднакъв номер).');
          continue;
        }
        if (!ed.ok || !ed.value) {
          issue(rowNo, `Дата: ${ed.ok ? 'липсва' : ed.error}.`);
          continue;
        }
        const description = text(at(r, 'Основание'));
        let e = out.entries.find((x) => x.key === key);
        if (!e) {
          e = { key, row: rowNo, date: ed.value, description, lines: [] };
          out.entries.push(e);
        } else if (e.date !== ed.value) {
          issue(rowNo, `Статия ${key} е с различни дати на редовете.`);
          continue;
        }
        e.lines.push(line);
      }
    }
  }

  // Whole entries and the opening balances must balance.
  for (const e of out.entries) {
    const problems = postingProblems(
      e.lines.map((l) => ({ accountCode: l.account, side: l.side, amount: l.amount })),
    );
    for (const p of problems) {
      out.issues.push({
        sheet: e.lines[0]?.sheet ?? 'Статии',
        row: e.row,
        message: `Статия ${e.key}: ${p.message}`,
      });
    }
  }
  if (out.opening.length) {
    const problems = postingProblems(
      out.opening.map((l) => ({ accountCode: l.account, side: l.side, amount: l.amount })),
    ).filter((p) => p.code === 'UNBALANCED');
    for (const p of problems) {
      out.issues.push({
        sheet: out.opening[0]?.sheet ?? 'Начални салда',
        row: out.opening[0]?.row ?? 0,
        message: `Началните салда не се равняват: ${p.message}`,
      });
    }
  }
  const dup = <T>(
    xs: T[],
    key: (x: T) => string,
    row: (x: T) => number,
    sheet: string,
    what: string,
  ) => {
    const s = new Map<string, number>();
    for (const x of xs) {
      const k = key(x);
      const first = s.get(k);
      if (first !== undefined) {
        out.issues.push({
          sheet,
          row: row(x),
          message: `${what} „${k}“ се повтаря (първо на ред ${first}).`,
        });
      } else s.set(k, row(x));
    }
  };
  dup(
    out.accounts,
    (a) => a.code,
    (a) => a.row,
    IMPORT_TEMPLATE.accounts.sheet,
    'Сметка',
  );
  dup(
    out.objects,
    (o) => o.code,
    (o) => o.row,
    IMPORT_TEMPLATE.objects.sheet,
    'Обект',
  );
  dup(
    out.counterparties.filter((c) => c.eik),
    (c) => c.eik ?? '',
    (c) => c.row,
    IMPORT_TEMPLATE.counterparties.sheet,
    'ЕИК',
  );
  return out;
}
