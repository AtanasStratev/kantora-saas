import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ecbRatesFor, parseBnbXml, parseEcbCsv, parseEcbXml, type EcbDays } from '@kantora/domain';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';

// Real files from ecb.europa.eu and bnb.bg kept as evidence in docs/legal/fx.
const sample = (f: string) => readFileSync(join(process.cwd(), 'docs/legal/fx', f), 'utf8');

const xml = parseEcbXml(sample('ecb-sample-hist-90d-to-2026-11-20.xml'));
const csv = parseEcbCsv(sample('ecb-sample-hist-extract.csv'));
const days = (r: typeof xml): EcbDays => {
  if (!r.ok) throw new Error(r.message);
  return r.days;
};
/** currency → rate as a number-free comparable string ("1.099" and "1.0990" are equal). */
const norm = (rates: { currency: string; quote: { rate: string } }[]) =>
  Object.fromEntries(rates.map((r) => [r.currency, new Decimal(r.quote.rate).toString()]));

describe('ECB files', () => {
  it('read every day and currency, without BGN', () => {
    const d = days(xml);
    expect(d['2026-11-20']?.length).toBe(29);
    expect(Object.keys(d).length).toBeGreaterThan(60);
    const c = days(csv);
    expect(c['2025-12-31']?.some((x) => x.currency === 'BGN')).toBe(false);
    expect(c['2026-01-02']?.find((x) => x.currency === 'USD')?.rate).toBe('1.1721');
  });

  it('refuse anything that is not an ECB file', () => {
    expect(parseEcbXml('<html>Error</html>').ok).toBe(false);
    expect(parseEcbCsv('Date,USD,\n2026-11-20,abc,\n').ok).toBe(false);
    expect(parseEcbCsv('<html></html>').ok).toBe(false);
  });
});

describe('ECB = BNB central rate (the basis of the owner decision)', () => {
  it('20.11.2026: the BNB publication equals the ECB rates of the day (29 of 29)', () => {
    const r = ecbRatesFor(days(xml), '2026-11-20', '2026-11-22');
    const bnb = parseBnbXml(sample('bnb-sample-2026-11-20-eur.xml'), '2026-11-20');
    expect(r.ok && bnb.ok).toBe(true);
    if (!r.ok || !bnb.ok) return;
    expect(r.sourceDate).toBe('2026-11-20');
    expect(norm(r.rates)).toEqual(norm(bnb.rates));
  });

  it('01.01.2026 (no ECB rate): the last ECB rates, 31.12.2025, exactly as the BNB did', () => {
    const r = ecbRatesFor(days(csv), '2026-01-01', '2026-11-22');
    const bnb = parseBnbXml(sample('bnb-sample-2026-01-01-eur.xml'), '2026-01-01');
    expect(r.ok && bnb.ok).toBe(true);
    if (!r.ok || !bnb.ok) return;
    expect(r.sourceDate).toBe('2025-12-31');
    expect(norm(r.rates)).toEqual(norm(bnb.rates));
  });
});

describe('ecbRatesFor', () => {
  const d = days(xml); // last day in the sample: Friday 20.11.2026

  it('a weekend day takes Friday', () => {
    expect(ecbRatesFor(d, '2026-11-21', '2026-11-22')).toMatchObject({
      ok: true,
      sourceDate: '2026-11-20',
    });
    expect(ecbRatesFor(d, '2026-11-22', '2026-11-22')).toMatchObject({
      ok: true,
      sourceDate: '2026-11-20',
    });
  });

  it('today on a working day without its own rate: not yet (never yesterday’s rate)', () => {
    expect(ecbRatesFor(d, '2026-11-23', '2026-11-23')).toEqual({ ok: false, reason: 'not_yet' });
  });

  it('a past working day the file does not reach: the file is stale, not "no rate"', () => {
    expect(ecbRatesFor(d, '2026-11-24', '2026-11-25')).toEqual({
      ok: false,
      reason: 'not_covered',
    });
    expect(ecbRatesFor(d, '2026-01-15', '2026-11-25')).toEqual({
      ok: false,
      reason: 'not_covered',
    });
  });

  it('the lev era is not the ECB’s business here', () => {
    expect(ecbRatesFor(days(csv), '2025-12-31', '2026-11-22')).toEqual({
      ok: false,
      reason: 'lev_era',
    });
  });
});
