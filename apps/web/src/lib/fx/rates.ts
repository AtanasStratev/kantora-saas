import 'server-only';
import {
  bnbXmlUrl,
  convertBgnToEur,
  convertWithBnbRate,
  eraOf,
  parseBnbXml,
  type BnbParse,
  type BnbRate,
} from '@kantora/domain';
import { withUser } from '@kantora/db';
import { appPool } from '../db';
import { resolveDay, type DayStatus, type ResolvedDay } from './resolve';

/**
 * BNB rates on demand: read from the database, and only when a day is missing, fetched
 * once from bnb.bg and stored (app.store_bnb_rates). The request to the BNB carries no
 * user or company data: only the date.
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

export async function bnbDay(userId: string, date: string): Promise<ResolvedDay> {
  return resolveDay(date, {
    today: todaySofia(),
    fetchDay: fetchFromBnb,
    stored: (d) =>
      withUser(appPool, userId, async (c) => {
        const day = await c.query<{ status: DayStatus }>(
          'SELECT status FROM app.exchange_rate_day WHERE rate_date = $1',
          [d],
        );
        const status = day.rows[0]?.status;
        if (!status) return undefined;
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
        return { status, rates };
      }),
    save: (d, status, rates) =>
      withUser(appPool, userId, async (c) => {
        await c.query('SELECT app.store_bnb_rates($1, $2, $3, $4)', [
          d,
          status,
          bnbXmlUrl(d),
          JSON.stringify(
            rates.map((r) => ({
              currency: r.currency,
              kind: r.quote.kind,
              rate: r.quote.rate,
              units: r.quote.kind === 'bgn_per_units' ? r.quote.units : 1,
            })),
          ),
        ]);
      }),
  });
}

export type Conversion =
  | {
      ok: true;
      /** Amount in the ledger currency of the date (BGN until 2025, EUR from 2026). */
      result: string;
      ledgerCurrency: 'BGN' | 'EUR';
      /** How it was computed, for the screen: "1000 ÷ 1,0990 (БНБ, 20.11.2026)". */
      rateDate: string | null;
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
      basis: `сума × ${peg} (фиксиран курс на лева към еврото, паричен съвет, БНБ)`,
    };
  }
  const day = await bnbDay(userId, date);
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
    basis:
      rate.quote.kind === 'per_eur'
        ? `сума ÷ ${rate.quote.rate} (${currency} за 1 евро)`
        : `сума × ${rate.quote.rate} ÷ ${rate.quote.units} (лева за ${rate.quote.units} ${currency})`,
  };
}
