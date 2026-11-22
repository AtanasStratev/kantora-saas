/**
 * ECB euro reference rates as the automatic source of the BNB central rates from 2026
 * (owner's decision 2026-11-22, ADR-0012). Verified on 2026-11-22: the BNB publication of a
 * day equals the ECB rates last published by that day (20.11.2026: 29 of 29 equal;
 * 01.01.2026: equal to the ECB rates of 31.12.2025). Samples in docs/legal/fx.
 * Strict: anything unexpected is an error, never a guessed rate.
 */
import { EURO_ERA_START, type BnbRate } from './fx';

export type EcbDays = Record<string, { currency: string; rate: string }[]>;
export type EcbParse = { ok: true; days: EcbDays } | { ok: false; message: string };

const DECIMAL = /^\d+(\.\d+)?$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const bad = (message: string): EcbParse => ({ ok: false, message });

function add(days: EcbDays, date: string, currency: string, rate: string): string | null {
  if (!ISO.test(date)) return `Неочаквана дата „${date}“ във файла от ЕЦБ.`;
  if (!/^[A-Z]{3}$/.test(currency)) return `Неочакван код на валута „${currency}“ от ЕЦБ.`;
  if (!DECIMAL.test(rate) || /^0+(\.0+)?$/.test(rate)) return `Неочакван курс „${rate}“ от ЕЦБ.`;
  // BGN stopped being a foreign currency for Bulgarian books on 1.01.2026.
  if (currency === 'BGN' || currency === 'EUR') return null;
  const list = (days[date] ??= []);
  if (list.some((x) => x.currency === currency)) return `Валута ${currency} се повтаря за ${date}.`;
  list.push({ currency, rate });
  return null;
}

/** eurofxref-daily.xml / eurofxref-hist-90d.xml */
export function parseEcbXml(xml: string): EcbParse {
  if (
    !xml.includes('http://www.ecb.int/vocabulary/2002-08-01/eurofxref') ||
    !xml.includes('<gesmes:name>European Central Bank</gesmes:name>')
  ) {
    return bad('Файлът не е във формата на ЕЦБ.');
  }
  const days: EcbDays = {};
  for (const m of xml.matchAll(
    /<Cube time="([^"]*)">([\s\S]*?)<\/Cube>(?=\s*(?:<Cube time=|<\/Cube>))/g,
  )) {
    const date = m[1] ?? '';
    for (const c of (m[2] ?? '').matchAll(/<Cube currency="([^"]*)" rate="([^"]*)"\s*\/>/g)) {
      const err = add(days, date, c[1] ?? '', c[2] ?? '');
      if (err) return bad(err);
    }
  }
  return Object.keys(days).length ? { ok: true, days } : bad('Във файла от ЕЦБ няма курсове.');
}

/** eurofxref-hist.csv (inside eurofxref-hist.zip): Date,USD,JPY,…; "N/A" = no rate. */
export function parseEcbCsv(csv: string): EcbParse {
  const lines = csv
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const header = (lines[0] ?? '').split(',');
  if (header[0] !== 'Date' || !header.includes('USD'))
    return bad('Файлът не е във формата на ЕЦБ.');
  const days: EcbDays = {};
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const date = cells[0] ?? '';
    for (let i = 1; i < header.length; i++) {
      const cur = header[i] ?? '';
      const v = (cells[i] ?? '').trim();
      if (!cur || v === '' || v === 'N/A') continue;
      const err = add(days, date, cur, v);
      if (err) return bad(err);
    }
  }
  return Object.keys(days).length ? { ok: true, days } : bad('Във файла от ЕЦБ няма курсове.');
}

const LOOKBACK = 10;
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isWeekend = (iso: string) => [0, 6].includes(new Date(`${iso}T12:00:00Z`).getUTCDay());

export type EcbRateFor =
  | { ok: true; sourceDate: string; rates: BnbRate[] }
  | {
      ok: false;
      /** not_yet: today's rates are not out; not_covered: this file does not cover the date. */
      reason: 'not_yet' | 'not_covered' | 'lev_era';
    };

/**
 * The rates that apply to `date`: the ECB publication of that day, or the last one before it
 * (weekend, holiday; also 1.01.2026 → 31.12.2025, exactly as the BNB did). For today only
 * today's own publication counts: the BNB publishes the day's rate after the ECB (~17:00).
 */
export function ecbRatesFor(days: EcbDays, date: string, today: string): EcbRateFor {
  if (date < EURO_ERA_START) return { ok: false, reason: 'lev_era' };
  const known = Object.keys(days).sort();
  const first = known[0];
  const last = known.at(-1);
  if (!first || !last || date < first) return { ok: false, reason: 'not_covered' };
  if (date >= today && !days[date] && !isWeekend(date)) return { ok: false, reason: 'not_yet' };
  // A past working day after the last day in the file: the file is stale, not "no rates".
  if (date > last) {
    for (let d = addDays(last, 1); d <= date; d = addDays(d, 1)) {
      if (!isWeekend(d) && d < today) return { ok: false, reason: 'not_covered' };
    }
  }
  for (let i = 0; i <= LOOKBACK; i++) {
    const d = addDays(date, -i);
    const list = days[d];
    if (list?.length) {
      return {
        ok: true,
        sourceDate: d,
        rates: list.map((x) => ({
          currency: x.currency,
          quote: { kind: 'per_eur', rate: x.rate },
        })),
      };
    }
  }
  return { ok: false, reason: 'not_covered' };
}

export const ECB_90D_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';
export const ECB_HIST_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip';
