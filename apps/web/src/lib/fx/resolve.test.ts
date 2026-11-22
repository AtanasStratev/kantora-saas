import type { BnbParse, BnbRate } from '@kantora/domain';
import { describe, expect, it } from 'vitest';
import { resolveDay, type DayStatus, type ResolveDeps } from './resolve';

const usd = (rate: string): BnbRate => ({ currency: 'USD', quote: { kind: 'per_eur', rate } });

/** An in-memory BNB and database; records what was fetched and saved. */
function world(today: string, bnb: Record<string, BnbParse>, db: Record<string, DayStatus> = {}) {
  const saved: Record<string, DayStatus> = {};
  const fetched: string[] = [];
  const deps: ResolveDeps = {
    today,
    stored: async (d) => {
      const s = saved[d] ?? db[d];
      return s ? { status: s, rates: s === 'published' ? [usd('1.1')] : [] } : undefined;
    },
    fetchDay: async (d) => {
      fetched.push(d);
      return bnb[d] ?? { ok: false, reason: 'no_publication', message: 'няма' };
    },
    save: async (d, s) => {
      saved[d] = s;
    },
  };
  return { deps, saved, fetched };
}
const published = (date: string, rate = '1.0990'): BnbParse => ({
  ok: true,
  date,
  era: 'EUR',
  rates: [usd(rate)],
  skipped: [],
});

describe('resolveDay', () => {
  it('uses the publication of the date itself and stores it', async () => {
    const w = world('2026-11-22', { '2026-11-20': published('2026-11-20') });
    const r = await resolveDay('2026-11-20', w.deps);
    expect(r).toMatchObject({ ok: true, rateDate: '2026-11-20', era: 'EUR' });
    expect(w.saved).toEqual({ '2026-11-20': 'published' });
  });

  it('on a weekend falls back to Friday and remembers the empty days', async () => {
    const w = world('2026-11-23', { '2026-11-20': published('2026-11-20') });
    const r = await resolveDay('2026-11-22', w.deps); // Sunday
    expect(r).toMatchObject({ ok: true, requested: '2026-11-22', rateDate: '2026-11-20' });
    expect(w.saved).toEqual({
      '2026-11-22': 'none',
      '2026-11-21': 'none',
      '2026-11-20': 'published',
    });
    // The second time nothing is fetched again.
    w.fetched.length = 0;
    await resolveDay('2026-11-22', w.deps);
    expect(w.fetched).toEqual([]);
  });

  it('today on a working day before the publication: says so, stores nothing', async () => {
    const w = world('2026-11-23', {}); // Monday, nothing yet
    const r = await resolveDay('2026-11-23', w.deps);
    expect(r).toEqual({
      ok: false,
      message:
        'Курсовете на БНБ за 23.11.2026 още не са публикувани (публикуват се около 17:00 ч.).',
    });
    expect(w.saved).toEqual({});
  });

  it('today on a weekend falls back without storing "none" for today', async () => {
    const w = world('2026-11-21', { '2026-11-20': published('2026-11-20') }); // Saturday
    const r = await resolveDay('2026-11-21', w.deps);
    expect(r).toMatchObject({ ok: true, rateDate: '2026-11-20' });
    expect(w.saved).toEqual({ '2026-11-20': 'published' });
  });

  it('never falls back from 2026 into the lev era', async () => {
    const w = world('2026-11-22', { '2025-12-31': published('2025-12-31') });
    const r = await resolveDay('2026-01-01', w.deps); // nothing on 1 Jan in this fake BNB
    expect(r).toEqual({
      ok: false,
      message: 'Няма публикувани курсове на БНБ в 10 дни до 01.01.2026.',
    });
    expect(w.fetched).toEqual(['2026-01-01']);
  });

  it('refuses the future and passes on BNB format errors', async () => {
    const w = world('2026-11-22', {
      '2026-11-20': {
        ok: false,
        reason: 'malformed',
        message: 'Неочакван формат на файла от БНБ.',
      },
    });
    expect(await resolveDay('2026-11-23', w.deps)).toMatchObject({ ok: false });
    expect(await resolveDay('2026-11-20', w.deps)).toEqual({
      ok: false,
      message: 'Неочакван формат на файла от БНБ.',
    });
    expect(w.saved).toEqual({});
  });
});
