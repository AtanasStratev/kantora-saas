/**
 * BNB central exchange rates (ЗСч чл. 5, ал. 1; Валутен закон чл. 12, ал. 1).
 * Format observed on bnb.bg and kept as samples in docs/legal/fx/ (see docs/legal/README.md).
 * The parser is strict: anything unexpected is an error, never a guessed rate.
 */
import type { BnbQuote } from './rounding';

/** The first day the BNB publishes euro rates instead of lev rates. */
export const EURO_ERA_START = '2026-01-01';

export type BnbRate = { currency: string; quote: BnbQuote };

export type BnbParse =
  | { ok: true; date: string; era: 'BGN' | 'EUR'; rates: BnbRate[]; skipped: string[] }
  | {
      ok: false;
      reason: 'no_publication' | 'unavailable' | 'malformed' | 'wrong_date';
      message: string;
    };

/** Text of the BNB page for a date without rates (docs/legal/fx sample, 2026-11-22). */
export const NO_DATA_MARKER = 'Няма данни по избраните критерии';

export const eraOf = (isoDate: string): 'BGN' | 'EUR' => (isoDate < EURO_ERA_START ? 'BGN' : 'EUR');

const DECIMAL = /^\d+(\.\d+)?$/;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescape(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e] ?? '').trim();
}

/** Flat `<ROW><TAG>text</TAG>…</ROW>` blocks; BNB rows have no nesting or attributes. */
function rows(xml: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const m of xml.matchAll(/<ROW>([\s\S]*?)<\/ROW>/g)) {
    const row: Record<string, string> = {};
    for (const f of (m[1] ?? '').matchAll(/<([A-Z0-9_]+)>([^<]*)<\/\1>/g)) {
      const key = f[1];
      if (key) row[key] = unescape(f[2] ?? '');
    }
    out.push(row);
  }
  return out;
}

const bgDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Parses the BNB XML for `isoDate` (YYYY-MM-DD) and checks it really is for that date. */
export function parseBnbXml(body: string, isoDate: string): BnbParse {
  const text = body.replace(/^\uFEFF/, '').trimStart();
  if (!text.startsWith('<?xml')) {
    // Only the BNB's own "no data" page means "nothing published that day". Any other
    // page (firewall block, maintenance, error) is temporary and must never be stored as
    // "no rates", or a real working day would lose its rates for good.
    if (text.includes(NO_DATA_MARKER)) {
      return {
        ok: false,
        reason: 'no_publication',
        message: `БНБ няма публикувани курсове за ${bgDate(isoDate)}.`,
      };
    }
    return {
      ok: false,
      reason: 'unavailable',
      message: 'Сайтът на БНБ временно не дава курсове. Опитайте отново след няколко минути.',
    };
  }
  if (!text.includes('<ROWSET>')) {
    return { ok: false, reason: 'malformed', message: 'Неочакван формат на файла от БНБ.' };
  }
  const all = rows(text);
  const header = all.find((r) => r['GOLD'] === '0');
  const era = eraOf(isoDate);
  const rateLabel = header?.['RATE'] ?? '';
  const expectedLabel = era === 'EUR' ? /евро/i : /BGN|лева/i;
  if (!header || !expectedLabel.test(rateLabel)) {
    return {
      ok: false,
      reason: 'malformed',
      message: `Файлът от БНБ не е във формата, очакван за ${era === 'EUR' ? '2026 г. и след това' : 'периода до 2025 г.'}.`,
    };
  }
  const rates: BnbRate[] = [];
  const skipped: string[] = [];
  for (const r of all) {
    if (r['GOLD'] !== '1') continue; // header row and gold
    const code = r['CODE'] ?? '';
    if (r['CURR_DATE'] !== bgDate(isoDate)) {
      return {
        ok: false,
        reason: 'wrong_date',
        message: `Файлът от БНБ е за ${r['CURR_DATE'] ?? '?'}, а не за ${bgDate(isoDate)}.`,
      };
    }
    if (!/^[A-Z]{3}$/.test(code)) {
      return { ok: false, reason: 'malformed', message: `Неочакван код на валута „${code}“.` };
    }
    const rate = r['RATE'] ?? '';
    if (!DECIMAL.test(rate) || /^0+(\.0+)?$/.test(rate)) {
      skipped.push(code); // e.g. RUB "n/a": no rate published
      continue;
    }
    if (era === 'EUR') {
      rates.push({ currency: code, quote: { kind: 'per_eur', rate } });
    } else {
      const units = Number(r['RATIO']);
      if (!/^\d+$/.test(r['RATIO'] ?? '') || units < 1) {
        skipped.push(code);
        continue;
      }
      rates.push({ currency: code, quote: { kind: 'bgn_per_units', rate, units } });
    }
  }
  if (rates.length === 0) {
    return { ok: false, reason: 'malformed', message: 'Във файла от БНБ няма нито един курс.' };
  }
  if (new Set(rates.map((x) => x.currency)).size !== rates.length) {
    return { ok: false, reason: 'malformed', message: 'Валута се повтаря във файла от БНБ.' };
  }
  return { ok: true, date: isoDate, era, rates, skipped };
}

/** The BNB address for the XML of one date (docs/legal/README.md). */
export function bnbXmlUrl(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return (
    'https://www.bnb.bg/Statistics/StExternalSector/StExchangeRates/StERForeignCurrencies/index.htm' +
    `?downloadOper=true&group1=first&firstDays=${d}&firstMonths=${m}&firstYear=${y}` +
    '&search=true&showChart=false&showChartButton=false&type=XML'
  );
}
