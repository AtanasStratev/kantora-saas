import { eraOf, type BnbParse, type BnbRate } from '@kantora/domain';

/**
 * Which BNB publication applies to a date (ЗСч чл. 5, ал. 1: "централният курс … към
 * датата на сделката"). For a day without a publication (weekend, holiday) the last
 * publication before it is used and the screen says so. ЗДДС чл. 26, ал. 6 (from 2026)
 * says this explicitly ("по последния обменен курс, публикуван … към момента"); ЗСч has no
 * text for such days (docs/legal/README.md). Pure logic: the database and
 * the network are passed in, so this is unit-tested without either.
 */
export const MAX_LOOKBACK_DAYS = 10;

export type DayStatus = 'published' | 'none';
export type FxSource = 'bnb' | 'ecb';
/** A stored day; rateDate is the publication used (ECB rows: the ECB day, else the day). */
export type StoredDay = {
  status: DayStatus;
  rates: BnbRate[];
  source: FxSource;
  rateDate: string;
};

export type ResolveDeps = {
  /** Today in Sofia, YYYY-MM-DD. */
  today: string;
  stored: (date: string) => Promise<StoredDay | undefined>;
  fetchDay: (date: string) => Promise<BnbParse>;
  save: (date: string, status: DayStatus, rates: BnbRate[]) => Promise<void>;
};

export type ResolvedDay =
  | {
      ok: true;
      requested: string;
      /** The day whose publication is used (earlier than `requested` on a day without one). */
      rateDate: string;
      source: FxSource;
      era: 'BGN' | 'EUR';
      rates: BnbRate[];
    }
  | { ok: false; message: string };

export const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isWeekend = (iso: string) => [0, 6].includes(new Date(`${iso}T12:00:00Z`).getUTCDay());
const bg = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export async function resolveDay(date: string, deps: ResolveDeps): Promise<ResolvedDay> {
  if (date > deps.today) {
    return { ok: false, message: `${bg(date)} е в бъдещето: БНБ още няма курсове за тази дата.` };
  }
  for (let i = 0; i <= MAX_LOOKBACK_DAYS; i++) {
    const d = addDays(date, -i);
    // Never mix eras: a 2026 date never falls back to a 2025 (lev) publication.
    if (eraOf(d) !== eraOf(date)) break;
    let day = await deps.stored(d);
    if (!day) {
      const p = await deps.fetchDay(d);
      if (p.ok) {
        await deps.save(d, 'published', p.rates);
        day = { status: 'published', rates: p.rates, source: 'bnb', rateDate: d };
      } else if (p.reason === 'no_publication') {
        if (d === deps.today && !isWeekend(d)) {
          return {
            ok: false,
            message: `Курсовете на БНБ за ${bg(d)} още не са публикувани (публикуват се около 17:00 ч.).`,
          };
        }
        // Today on a weekend: nothing will come today, but it is not stored either.
        if (d !== deps.today) await deps.save(d, 'none', []);
        day = { status: 'none', rates: [], source: 'bnb', rateDate: d };
      } else {
        return { ok: false, message: p.message };
      }
    }
    if (day.status === 'published') {
      return {
        ok: true,
        requested: date,
        rateDate: day.rateDate,
        era: eraOf(date),
        rates: day.rates,
        source: day.source,
      };
    }
  }
  return {
    ok: false,
    message: `Няма публикувани курсове на БНБ в ${MAX_LOOKBACK_DAYS} дни до ${bg(date)}.`,
  };
}
