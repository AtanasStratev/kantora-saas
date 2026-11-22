import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bnbXmlUrl, convertWithBnbRate, eraOf, parseBnbXml } from '@kantora/domain';

// Real files from bnb.bg, kept as evidence in docs/legal/fx (see docs/legal/README.md).
const sample = (f: string) => readFileSync(join(process.cwd(), 'docs/legal/fx', f), 'utf8');

describe('BNB rates: euro era (from 2026)', () => {
  const r = parseBnbXml(sample('bnb-sample-2026-11-20-eur.xml'), '2026-11-20');

  it('reads every currency as "units per 1 EUR"', () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.era).toBe('EUR');
    expect(r.rates.find((x) => x.currency === 'USD')?.quote).toEqual({
      kind: 'per_eur',
      rate: '1.0990',
    });
    expect(r.rates.find((x) => x.currency === 'JPY')?.quote).toEqual({
      kind: 'per_eur',
      rate: '174.35',
    });
    expect(r.rates.length).toBeGreaterThan(20);
    expect(r.rates.some((x) => x.currency === 'XAU')).toBe(false);
  });

  it('converts by dividing by RATE, not with the rounded REVERSERATE', () => {
    // 1000 USD / 1.0990 = 909.918… → 909.92 (1000 × 0.9099 would give 909.90).
    expect(convertWithBnbRate('1000', { kind: 'per_eur', rate: '1.0990' }).toFixed(2)).toBe(
      '909.92',
    );
  });

  it('refuses the file of another date', () => {
    const wrong = parseBnbXml(sample('bnb-sample-2026-11-20-eur.xml'), '2026-11-19');
    expect(wrong).toMatchObject({ ok: false, reason: 'wrong_date' });
  });
});

describe('BNB rates: lev era (until 2025)', () => {
  const r = parseBnbXml(sample('bnb-sample-2025-12-30-bgn.xml'), '2025-12-30');

  it('reads "BGN for N units" and skips currencies without a rate', () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.era).toBe('BGN');
    expect(r.rates.find((x) => x.currency === 'BRL')?.quote).toEqual({
      kind: 'bgn_per_units',
      rate: '3.01226',
      units: 10,
    });
    expect(r.rates.find((x) => x.currency === 'AUD')?.quote).toEqual({
      kind: 'bgn_per_units',
      rate: '1.11488',
      units: 1,
    });
    expect(r.skipped).toContain('RUB');
  });

  it('converts with the units (10 BRL = 3.01226 BGN)', () => {
    const q = { kind: 'bgn_per_units', rate: '3.01226', units: 10 } as const;
    expect(convertWithBnbRate('10', q).toFixed(2)).toBe('3.01');
    expect(convertWithBnbRate('12345.67', q).toFixed(2)).toBe('3718.84'); // 3718.8368…
  });

  it('a lev-era file is refused for a euro-era date (and the other way round)', () => {
    expect(parseBnbXml(sample('bnb-sample-2025-12-30-bgn.xml'), '2026-12-30')).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    expect(parseBnbXml(sample('bnb-sample-2026-11-20-eur.xml'), '2025-11-20')).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('BNB responses that are not rates', () => {
  it('a day without publication (HTML page) is "no publication", not an error', () => {
    expect(parseBnbXml(sample('bnb-sample-2026-11-21-no-publication.html'), '2026-11-21')).toEqual({
      ok: false,
      reason: 'no_publication',
      message: 'БНБ няма публикувани курсове за 21.11.2026.',
    });
  });

  it('a firewall or error page is "unavailable", never "no publication"', () => {
    expect(parseBnbXml(sample('bnb-sample-blocked.html'), '2026-11-20')).toEqual({
      ok: false,
      reason: 'unavailable',
      message: 'Сайтът на БНБ временно не дава курсове. Опитайте отново след няколко минути.',
    });
  });

  it('broken or suspicious XML is refused', () => {
    const head = `<?xml version="1.0"?><ROWSET><ROW><GOLD>0</GOLD><RATE>Чуждестранна валута за едно евро</RATE></ROW>`;
    const row = (code: string, rate: string) =>
      `<ROW><GOLD>1</GOLD><CURR_DATE>20.11.2026</CURR_DATE><CODE>${code}</CODE><RATE>${rate}</RATE></ROW>`;
    expect(parseBnbXml(`${head}</ROWSET>`, '2026-11-20')).toMatchObject({ reason: 'malformed' });
    expect(parseBnbXml(`${head}${row('usd', '1.1')}</ROWSET>`, '2026-11-20')).toMatchObject({
      reason: 'malformed',
    });
    expect(
      parseBnbXml(`${head}${row('USD', '1.1')}${row('USD', '1.2')}</ROWSET>`, '2026-11-20'),
    ).toMatchObject({ reason: 'malformed' });
    expect(parseBnbXml(`${head}${row('USD', '0')}</ROWSET>`, '2026-11-20')).toMatchObject({
      reason: 'malformed',
    });
    expect(parseBnbXml('<html></html>', '2026-11-20')).toMatchObject({ reason: 'unavailable' });
  });

  it('rejects impossible rates in the conversion itself', () => {
    expect(() => convertWithBnbRate('1', { kind: 'per_eur', rate: '0' })).toThrow();
    expect(() => convertWithBnbRate('1', { kind: 'bgn_per_units', rate: '1', units: 0 })).toThrow();
    expect(() => convertWithBnbRate('1,5', { kind: 'per_eur', rate: '1' })).toThrow();
  });
});

it('era and URL', () => {
  expect([eraOf('2025-12-31'), eraOf('2026-01-01')]).toEqual(['BGN', 'EUR']);
  expect(bnbXmlUrl('2026-01-02')).toContain('firstDays=02&firstMonths=01&firstYear=2026');
});
