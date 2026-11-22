import 'server-only';
import {
  bnbXmlUrl,
  convertBgnToEur,
  convertWithBnbRate,
  ECB_90D_URL,
  ECB_HIST_URL,
  ecbRatesFor,
  eraOf,
  parseBnbXml,
  parseEcbCsv,
  parseEcbXml,
  type BnbParse,
  type BnbRate,
  type EcbParse,
} from '@kantora/domain';
import { withUser } from '@kantora/db';
import { strFromU8, unzipSync } from 'fflate';
import { appPool } from '../db';
import {
  addDays,
  resolveDay,
  type DayStatus,
  type FxSource,
  type ResolvedDay,
  type StoredDay,
} from './resolve';

/**
 * Central rates on demand (ADR-0012): read from the database; when a day is missing, from
 * 2026 the ECB reference rates (equal to the BNB publication, verified), with the BNB as
 * fallback; until 2025 the BNB only. Fetched once and stored. Requests carry no user or
 * company data, only the date.
 */
export const todaySofia = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(new Date());

// The BNB website has a firewall that blocks bursts of requests (seen 2026-11-22), so
// requests from this process go one at a time with a pause between them.
const MIN_GAP_MS = 1500;
let queue: Promise<unknown> = Promise.resolve();
let lastRequest = 0;
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequest + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastRequest = Date.now();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

function fetchFromBnb(date: string): Promise<BnbParse> {
  return throttled(() => fetchOnce(date));
}

async function fetchOnce(date: string): Promise<BnbParse> {
  try {
    const res = await fetch(bnbXmlUrl(date), {
      headers: { 'User-Agent': 'Kantora/1.0 (exchange rates)' },
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    });
    if (!res.ok) {
      return { ok: false, reason: 'unavailable', message: `БНБ отговори с грешка ${res.status}.` };
    }
    return parseBnbXml(await res.text(), date);
  } catch {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'Сайтът на БНБ не отговаря. Опитайте отново след малко.',
    };
  }
}

function stored(userId: string, d: string): Promise<StoredDay | undefined> {
  return withUser(appPool, userId, async (c) => {
    const day = await c.query<{ status: DayStatus; source: FxSource; source_date: string | null }>(
      `SELECT status, source, to_char(source_date, 'YYYY-MM-DD') AS source_date
       FROM app.exchange_rate_day WHERE rate_date = $1`,
      [d],
    );
    const row = day.rows[0];
    if (!row) return undefined;
    const r = await c.query<{ currency: string; kind: string; rate: string; units: number }>(
      `SELECT currency, kind, rate::text, units FROM app.exchange_rate
       WHERE rate_date = $1 ORDER BY currency`,
      [d],
    );
    const rates: BnbRate[] = r.rows.map((x) => ({
      currency: x.currency,
      quote:
        x.kind === 'per_eur'
          ? { kind: 'per_eur', rate: x.rate }
          : { kind: 'bgn_per_units', rate: x.rate, units: x.units },
    }));
    return { status: row.status, rates, source: row.source, rateDate: row.source_date ?? d };
  });
}

function save(
  userId: string,
  d: string,
  status: DayStatus,
  source: FxSource,
  url: string,
  sourceDate: string | null,
  rates: BnbRate[],
): Promise<void> {
  return withUser(appPool, userId, async (c) => {
    await c.query('SELECT app.store_fx_rates($1, $2, $3, $4, $5, $6)', [
      d,
      status,
      source,
      url,
      sourceDate,
      JSON.stringify(
        rates.map((r) => ({
          currency: r.currency,
          kind: r.quote.kind,
          rate: r.quote.rate,
          units: r.quote.kind === 'bgn_per_units' ? r.quote.units : 1,
        })),
      ),
    ]);
  });
}

// ECB files: kept in memory for 30 minutes so that several dates cost one download.
const ECB_TTL_MS = 30 * 60_000;
const ecbCache = new Map<string, { at: number; parsed: EcbParse }>();
async function ecbFile(url: string): Promise<EcbParse> {
  const hit = ecbCache.get(url);
  if (hit && Date.now() - hit.at < ECB_TTL_MS) return hit.parsed;
  const parsed = await throttled(async (): Promise<EcbParse> => {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Kantora/1.0 (exchange rates)' },
        signal: AbortSignal.timeout(30_000),
        cache: 'no-store',
      });
      if (!res.ok) return { ok: false, message: `ЕЦБ отговори с грешка ${res.status}.` };
      if (url.endsWith('.zip')) {
        const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
        const csv = files['eurofxref-hist.csv'];
        return csv ? parseEcbCsv(strFromU8(csv)) : { ok: false, message: 'Празен архив от ЕЦБ.' };
      }
      return parseEcbXml(await res.text());
    } catch {
      return { ok: false, message: 'Сайтът на ЕЦБ не отговаря.' };
    }
  });
  if (parsed.ok) ecbCache.set(url, { at: Date.now(), parsed });
  return parsed;
}

type EcbTry = ResolvedDay | { ok: false; fallback: true };

/** The ECB rates for a euro-era date, stored under that date with their ECB day. */
async function fromEcb(userId: string, date: string, today: string): Promise<EcbTry> {
  // The 90-day file is small; older dates need the full history (about 650 KB).
  const urls = date >= addDays(today, -80) ? [ECB_90D_URL, ECB_HIST_URL] : [ECB_HIST_URL];
  for (const url of urls) {
    const file = await ecbFile(url);
    if (!file.ok) return { ok: false, fallback: true };
    const r = ecbRatesFor(file.days, date, today);
    if (r.ok) {
      await save(userId, date, 'published', 'ecb', url, r.sourceDate, r.rates);
      return {
        ok: true,
        requested: date,
        rateDate: r.sourceDate,
        era: 'EUR',
        rates: r.rates,
        source: 'ecb',
      };
    }
    if (r.reason === 'not_yet') {
      const bg = date.split('-').reverse().join('.');
      return {
        ok: false,
        message: `Курсовете за ${bg} още не са публикувани (ЕЦБ около 16:00 ч., БНБ около 17:00 ч.).`,
      };
    }
  }
  return { ok: false, fallback: true };
}

export async function fxDay(userId: string, date: string): Promise<ResolvedDay> {
  const today = todaySofia();
  const own = await stored(userId, date);
  if (own?.status === 'published') {
    return {
      ok: true,
      requested: date,
      rateDate: own.rateDate,
      era: eraOf(date),
      rates: own.rates,
      source: own.source,
    };
  }
  if (!own && eraOf(date) === 'EUR' && date <= today) {
    const ecb = await fromEcb(userId, date, today);
    if (!('fallback' in ecb)) return ecb;
  }
  // Until 2025, or when the ECB cannot be reached: the BNB, day by day.
  return resolveDay(date, {
    today,
    fetchDay: fetchFromBnb,
    stored: (d) => stored(userId, d),
    save: (d, status, rates) => save(userId, d, status, 'bnb', bnbXmlUrl(d), null, rates),
  });
}

/** A rate as published, with the Bulgarian decimal comma (1.0990 → 1,0990). */
const bg = (rate: string) => rate.replace(/(\d)\.(\d)/, '$1,$2');

export type Conversion =
  | {
      ok: true;
      /** Amount in the ledger currency of the date (BGN until 2025, EUR from 2026). */
      result: string;
      ledgerCurrency: 'BGN' | 'EUR';
      /** How it was computed, for the screen: "1000 ÷ 1,0990 (БНБ, 20.11.2026)". */
      rateDate: string | null;
      /** Where the rate came from (null when no rate is used). */
      source?: FxSource;
      basis: string;
    }
  | { ok: false; message: string };

/** `amount` (a plain decimal string) of `currency` on `date`, in the ledger currency. */
export async function toLedgerCurrency(
  userId: string,
  amount: string,
  currency: string,
  date: string,
): Promise<Conversion> {
  const era = eraOf(date);
  if (currency === era) {
    return {
      ok: true,
      result: amount,
      ledgerCurrency: era,
      rateDate: null,
      basis: 'без преизчисляване',
    };
  }
  if (era === 'EUR' && currency === 'BGN') {
    // Fixed rate, ЗВЕРБ чл. 12–13 (docs/legal/README.md).
    return {
      ok: true,
      result: convertBgnToEur(amount).toFixed(2),
      ledgerCurrency: 'EUR',
      rateDate: null,
      basis: 'фиксиран курс 1,95583 (ЗВЕРБ, чл. 12–13)',
    };
  }
  if (era === 'BGN' && currency === 'EUR') {
    // Currency board: the BNB rate of the euro was the fixed 1.95583, read from the legal
    // parameter with its source and validity (no publication = refuse, never a guess).
    const peg = await withUser(appPool, userId, async (c) => {
      const r = await c.query<{ v: string | null }>(
        `SELECT app.legal_numeric('bgn_per_eur_currency_board', $1)::text AS v`,
        [date],
      );
      return r.rows[0]?.v ?? null;
    });
    if (!peg) {
      return {
        ok: false,
        message: 'За тази дата няма проверен курс на лева към еврото в програмата.',
      };
    }
    return {
      ok: true,
      result: convertWithBnbRate(amount, { kind: 'bgn_per_units', rate: peg, units: 1 }).toFixed(2),
      ledgerCurrency: 'BGN',
      rateDate: null,
      basis: `сума × ${bg(peg)} (фиксиран курс на лева към еврото, паричен съвет, БНБ)`,
    };
  }
  const day = await fxDay(userId, date);
  if (!day.ok) return day;
  const rate = day.rates.find((r) => r.currency === currency);
  if (!rate) {
    return {
      ok: false,
      message: `БНБ няма курс за ${currency} в публикацията от ${day.rateDate.split('-').reverse().join('.')}.`,
    };
  }
  return {
    ok: true,
    result: convertWithBnbRate(amount, rate.quote).toFixed(2),
    ledgerCurrency: era,
    rateDate: day.rateDate,
    source: day.source,
    basis:
      rate.quote.kind === 'per_eur'
        ? `сума ÷ ${bg(rate.quote.rate)} (${currency} за 1 евро)`
        : `сума × ${bg(rate.quote.rate)} ÷ ${rate.quote.units} (лева за ${rate.quote.units} ${currency})`,
  };
}
