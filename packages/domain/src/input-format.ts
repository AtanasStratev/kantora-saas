/**
 * Parsing and formatting of amounts and dates as Bulgarian accountants type them
 * (PROMPT.md 5.2, design-system.md §3–5). Pure functions, no UI or database.
 */
import Decimal from 'decimal.js';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const D = Decimal.clone({ precision: 40 });
// Regular space, no-break space, narrow no-break space, thin space, apostrophe as thousands.
const GROUP_CHARS = /[\s\u00a0\u202f\u2009']/g;

/**
 * Parses a typed amount into a plain decimal string ("-1234.56").
 * Accepts "1 234,56", "1234.56", "1234,56", "1.234,56", "1,234.56", "-12", "+5".
 * The LAST "," or "." is the decimal separator when both appear; repeated identical
 * separators ("1.234.567") are thousands. A lone separator is always decimal, so "1,234"
 * is rejected for money (3 decimals) with a clear message rather than silently guessed.
 */
export function parseAmount(input: string, maxDecimals = 2): ParseResult<string> {
  const raw = input.replace(GROUP_CHARS, '');
  if (raw === '') return { ok: false, error: 'Въведете сума.' };
  if (!/^[+-]?[\d.,]+$/.test(raw)) {
    return { ok: false, error: 'Сумата може да съдържа само цифри, запетая или точка.' };
  }
  const sign = raw.startsWith('-') ? '-' : '';
  const body = raw.replace(/^[+-]/, '');
  const lastSep = Math.max(body.lastIndexOf(','), body.lastIndexOf('.'));
  let intPart = body;
  let fracPart = '';
  if (lastSep >= 0) {
    const both = body.includes(',') && body.includes('.');
    const sepCount = (body.match(/[.,]/g) ?? []).length;
    if (both || sepCount === 1) {
      intPart = body.slice(0, lastSep).replace(/[.,]/g, '');
      fracPart = body.slice(lastSep + 1);
    } else {
      // Several identical separators ("1.234.567"): thousands grouping, no decimals.
      intPart = body.replace(/[.,]/g, '');
    }
  }
  if (intPart === '' && fracPart === '') return { ok: false, error: 'Въведете сума.' };
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) {
    return { ok: false, error: 'Неразпозната сума. Пример: 1 234,56' };
  }
  if (fracPart.length > maxDecimals) {
    return {
      ok: false,
      error: `Сумата може да има най-много ${maxDecimals} знака след запетаята.`,
    };
  }
  const value = new D(`${sign}${intPart || '0'}.${fracPart || '0'}`);
  return {
    ok: true,
    value: value.isZero() ? value.abs().toFixed(fracPart.length) : value.toFixed(fracPart.length),
  };
}

/** Formats a decimal string as "1 234,56" (narrow no-break space for thousands). */
export function formatAmount(value: string | Decimal, decimals = 2): string {
  const d = new D(value);
  const fixed = d.abs().toFixed(decimals);
  const [int, frac] = fixed.split('.') as [string, string | undefined];
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const sign = d.isNegative() && !d.isZero() ? '-' : '';
  return frac ? `${sign}${grouped},${frac}` : `${sign}${grouped}`;
}

export type IsoDate = string; // "YYYY-MM-DD"
export type PeriodContext = { year: number; month: number; today: IsoDate };

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function build(y: number, m: number, d: number): ParseResult<IsoDate> {
  if (m < 1 || m > 12) return { ok: false, error: `Няма месец ${m}.` };
  const max = daysInMonth(y, m);
  if (d < 1 || d > max) {
    return {
      ok: false,
      error: `${String(m).padStart(2, '0')}.${y} има ${max} дни; ${d} не е валиден ден.`,
    };
  }
  return { ok: true, value: iso(y, m, d) };
}

/**
 * Quick date entry relative to the current period:
 *  "15" → 15th of the period month; "1511" or "15.11" → 15 Nov of the period year;
 *  "15.11.26" / "15.11.2026" → full date; "+1" / "-3" → days relative to today;
 *  "д" or "т" (днес) → today.
 */
export function parseQuickDate(input: string, ctx: PeriodContext): ParseResult<IsoDate> {
  const s = input.trim().toLowerCase();
  if (s === '') return { ok: false, error: 'Въведете дата.' };
  if (s === 'д' || s === 'т' || s === 'днес') return { ok: true, value: ctx.today };

  const rel = /^([+-])(\d{1,3})$/.exec(s);
  if (rel) {
    const base = new Date(`${ctx.today}T00:00:00Z`);
    base.setUTCDate(base.getUTCDate() + (rel[1] === '-' ? -1 : 1) * Number(rel[2]));
    return { ok: true, value: base.toISOString().slice(0, 10) };
  }

  if (/^\d{1,2}$/.test(s)) return build(ctx.year, ctx.month, Number(s));
  if (/^\d{4}$/.test(s)) return build(ctx.year, Number(s.slice(2)), Number(s.slice(0, 2)));

  const parts = s.split(/[./\-\s]+/).filter(Boolean);
  if (parts.length >= 2 && parts.length <= 3 && parts.every((p) => /^\d+$/.test(p))) {
    const [d, m, y] = parts.map(Number) as [number, number, number | undefined];
    const yearDigits = parts[2]?.length ?? 0;
    let year = ctx.year;
    if (y !== undefined) {
      if (yearDigits === 2) year = 2000 + y;
      else if (yearDigits === 4) year = y;
      else return { ok: false, error: 'Годината трябва да е с 2 или 4 цифри.' };
    }
    return build(year, m, d);
  }
  return { ok: false, error: 'Неразпозната дата. Примери: 15, 15.11, 15.11.2026, +1' };
}

/** Formats an ISO date as "dd.mm.yyyy". */
export function formatDate(value: IsoDate): string {
  const [y, m, d] = value.split('-');
  return `${d}.${m}.${y}`;
}
