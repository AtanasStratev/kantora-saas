/**
 * Курсове на БНБ, keyboard only. The test never calls bnb.bg (its firewall blocks bursts of
 * requests, risk Т12): it stores the REAL BNB files kept as evidence in docs/legal/fx through
 * the same checked function the application uses. They are true data, so storing them is
 * correct and idempotent with any later real download of the same days.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { parseBnbXml } from '../../packages/domain/src/fx';
import { OWNER_STATE, sharedOwner } from './owner';

test.use({ storageState: OWNER_STATE });

if (existsSync('.env')) process.loadEnvFile('.env');

async function storeBnbSamples() {
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
  await Promise.all([admin.connect(), app.connect()]);
  try {
    const owner = await admin.query<{ id: string }>('SELECT id FROM auth."user" WHERE email = $1', [
      sharedOwner().email,
    ]);
    const userId = owner.rows[0]?.id;
    if (!userId) throw new Error('shared owner not found');
    const days: [string, string][] = [
      ['2026-11-20', 'bnb-sample-2026-11-20-eur.xml'],
      ['2026-11-21', 'bnb-sample-2026-11-21-no-publication.html'],
      ['2025-12-30', 'bnb-sample-2025-12-30-bgn.xml'],
    ];
    for (const [date, file] of days) {
      const p = parseBnbXml(readFileSync(`docs/legal/fx/${file}`, 'utf8'), date);
      if (!p.ok && p.reason !== 'no_publication') throw new Error(p.message);
      const rates = p.ok
        ? p.rates.map((r) => ({
            currency: r.currency,
            kind: r.quote.kind,
            rate: r.quote.rate,
            units: r.quote.kind === 'bgn_per_units' ? r.quote.units : 1,
          }))
        : [];
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
      await app.query('SELECT app.store_bnb_rates($1, $2, $3, $4)', [
        date,
        p.ok ? 'published' : 'none',
        'https://www.bnb.bg/Statistics/StExternalSector/StExchangeRates/StERForeignCurrencies/index.htm',
        JSON.stringify(rates),
      ]);
      await app.query('COMMIT');
    }
  } finally {
    await Promise.all([admin.end(), app.end()]);
  }
}

async function convert(page: Page, date: string, amount: string, currency: string) {
  const dateField = page.getByLabel('Дата');
  await dateField.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(date);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Control+A');
  await page.keyboard.type(amount);
  await page.keyboard.press('Tab');
  await page.getByLabel('Валута').selectOption(currency); // native select; keyboard by type-ahead
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.waitForURL(/amount=/);
}

test.describe('BNB rates, keyboard only', () => {
  test.beforeAll(storeBnbSamples);

  test('rates of a day, a weekend day, the lev era, and conversion', async ({ page, context }) => {
    test.setTimeout(180_000);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.locator('body').press('g');
    await page.locator('body').press('k');
    await expect(page).toHaveURL(/\/rates/);

    // Euro era: currency per 1 EUR, euro = amount ÷ RATE (not the rounded reverse rate).
    await convert(page, '20.11.2026', '1000', 'USD');
    const result = page.getByTestId('conversion');
    await expect(result).toContainText(/1\s000,00 USD = 909,92 EUR/);
    await expect(result).toContainText('курс на БНБ от 20.11.2026');
    await expect(result).toContainText('сума ÷ 1,0990 (USD за 1 евро)');
    await expect(page.getByRole('row', { name: /USD/ })).toContainText('USD за 1 евро');

    // Saturday: no publication, the last published one (Friday) with the legal reason shown.
    await convert(page, '21.11.2026', '1000', 'USD');
    await expect(page.getByRole('note')).toContainText('от 20.11.2026');
    await expect(page.getByRole('note')).toContainText('ЗДДС, чл. 26, ал. 6');
    await expect(result).toContainText(/909,92 EUR/);

    // Lev era: BGN for N units; and euro at the currency-board rate.
    await convert(page, '30.12.2025', '10', 'BRL');
    await expect(result).toContainText(/10,00 BRL = 3,01 BGN/);
    await expect(page.getByRole('row', { name: /BRL/ })).toContainText('лева за 10 BRL');
    await convert(page, '30.12.2025', '100', 'EUR');
    await expect(result).toContainText(/100,00 EUR = 195,58 BGN/);
    await expect(result).toContainText('фиксиран курс на лева към еврото');

    // A date in the future is explained, not guessed.
    await convert(page, '01.01.2099', '1', 'USD');
    await expect(page.getByText(/е в бъдещето/)).toBeVisible();

    // axe and screenshots in the three themes.
    for (const theme of ['light', 'dark', 'black'] as const) {
      await context.addCookies([
        { name: 'kantora-theme', value: theme, url: 'http://localhost:3000' },
      ]);
      await page.goto('/rates?date=21.11.2026&amount=1000&currency=USD');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(result).toBeVisible();
      const axe = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
      await page.screenshot({ path: `test-results/screens/rates-${theme}.png`, fullPage: true });
    }
  });
});
