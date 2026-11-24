/**
 * Currency lines and the month-end revaluation, keyboard only. No request to the ECB:
 * the REAL ECB file kept as evidence in docs/legal/fx is stored through the same checked
 * function the application uses (idempotent with a later real download of those days).
 */
import { expect, test, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { ECB_90D_URL, ecbRatesFor, parseEcbXml } from '../../packages/domain/src/ecb';
import { formatAmount } from '../../packages/domain/src/input-format';
import { convertWithBnbRate } from '../../packages/domain/src/rounding';
import { checkThemes } from './a11y';
import { OWNER_STATE, sharedOwner } from './owner';

test.use({ storageState: OWNER_STATE });
if (existsSync('.env')) process.loadEnvFile('.env');

const FILE = 'docs/legal/fx/ecb-sample-hist-90d-to-2026-11-20.xml';
const DAYS = ['2026-10-01', '2026-10-31'] as const; // 31.10 is a Saturday → the rate of 30.10

/** Stores the sample's rates for DAYS and returns the USD quote of each day. */
async function storeEcbSamples(): Promise<Record<string, string>> {
  const parsed = parseEcbXml(readFileSync(FILE, 'utf8'));
  if (!parsed.ok) throw new Error(parsed.message);
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
  await Promise.all([admin.connect(), app.connect()]);
  const usd: Record<string, string> = {};
  try {
    const owner = await admin.query<{ id: string }>('SELECT id FROM auth."user" WHERE email = $1', [
      sharedOwner().email,
    ]);
    const userId = owner.rows[0]?.id;
    if (!userId) throw new Error('shared owner not found');
    for (const date of DAYS) {
      const r = ecbRatesFor(parsed.days, date, '2026-11-20');
      if (!r.ok) throw new Error(`no sample rates for ${date}`);
      const q = r.rates.find((x) => x.currency === 'USD')?.quote;
      if (!q || q.kind !== 'per_eur') throw new Error('no USD');
      usd[date] = q.rate;
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
      await app.query('SELECT app.store_fx_rates($1, $2, $3, $4, $5, $6)', [
        date,
        'published',
        'ecb',
        ECB_90D_URL,
        r.sourceDate,
        JSON.stringify(
          r.rates.map((x) => ({
            currency: x.currency,
            kind: x.quote.kind,
            rate: x.quote.rate,
            units: 1,
          })),
        ),
      ]);
      await app.query('COMMIT');
    }
  } finally {
    await Promise.all([admin.end(), app.end()]);
  }
  return usd;
}

/** Amounts as the screens show them (same formatter). */
const bg = (v: string) => formatAmount(v);

async function go(page: Page, key: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('g');
  await page.locator('body').press(key);
}

test.describe('currency and revaluation, keyboard only', () => {
  test('a USD line at the rate of the day, revalued at the month-end rate', async ({
    page,
    context,
  }) => {
    test.setTimeout(300_000);
    const usd = await storeEcbSamples();
    const [first, last] = [usd['2026-10-01'], usd['2026-10-31']];
    if (!first || !last) throw new Error('sample rates missing');
    const booked = convertWithBnbRate('1000', { kind: 'per_eur', rate: first });
    const revalued = convertWithBnbRate('1000', { kind: 'per_eur', rate: last });
    const diff = revalued.minus(booked);

    const company = `Валути ${randomBytes(3).toString('hex')} ООД`;
    await page.goto('/companies');
    await page.getByLabel('Наименование').fill(company);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('cell', { name: company, exact: true })).toBeVisible();
    await page.locator('body').press('Control+Shift+K');
    await page.keyboard.type(company);
    await page.keyboard.press('Enter');
    await expect(page.locator('header')).toContainText(company);
    await page.locator('body').press('Alt+P');
    await page.keyboard.type('окт');
    await page.keyboard.press('Enter');
    await expect(page.locator('header')).toContainText('октомври 2026');

    await go(page, 's');
    for (const [code, name, currency] of [
      ['504', 'Разплащателна сметка в USD', true],
      ['702', 'Приходи от услуги', false],
      ['624', 'Разходи от курсови разлики', false],
      ['724', 'Приходи от курсови разлики', false],
    ] as const) {
      await page.getByLabel('Код').fill(code);
      await page.getByLabel('Наименование').fill(name);
      if (currency) {
        await page
          .getByRole('checkbox', { name: 'Валутна (парична позиция в чуждестранна валута)' })
          .press('Space');
      }
      await page.getByLabel('Наименование').press('Enter');
      await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
    }

    // F2: 504 → currency → amount in USD → Enter converts at the rate of 01.10.2026.
    await page.locator('body').press('F2');
    const date = page.getByLabel(/Дата/);
    await date.press('Control+A');
    await page.keyboard.type('1.10');
    await page.keyboard.press('Enter');
    await page.keyboard.type('504');
    await expect(page.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Ред 1, валута')).toBeFocused();
    await page.keyboard.type('usd');
    await page.keyboard.press('Enter');
    await page.keyboard.type('1000');
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Ред 1, дебит')).toHaveValue(bg(booked.toFixed(2)));
    await expect(page.getByLabel('Ред 1, дебит')).toBeFocused();
    await expect(
      page.getByText(
        /^Ред 1: 1\s000,00 USD = .* EUR: сума ÷ .* \(USD за 1 евро\), ЕЦБ, 01\.10\.2026$/,
      ),
    ).toBeVisible();
    // Ctrl+→ moves it to the credit and back.
    await page.keyboard.press('Control+ArrowRight');
    await expect(page.getByLabel('Ред 1, кредит')).toHaveValue(bg(booked.toFixed(2)));
    await page.keyboard.press('Control+ArrowLeft');
    await expect(page.getByLabel('Ред 1, дебит')).toHaveValue(bg(booked.toFixed(2)));
    await page.getByLabel('Ред 2, сметка').focus();
    await page.keyboard.type('702');
    await page.keyboard.press('Enter'); // non-currency account: straight to the debit
    await expect(page.getByLabel('Ред 2, дебит')).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('F9');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByText(/Статия № 1 от 01\.10\.2026 е осчетоводена/)).toBeVisible();

    // Revaluation at 31.10.2026 (the rate of 30.10).
    await page.goto('/journal');
    await page.getByRole('link', { name: 'Преоценка на валути' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Преоценка на валутните позиции',
    );
    const row = page.getByRole('row', { name: /504 USD/ });
    await expect(row).toContainText(/1\s000,00 Дт/);
    await expect(row).toContainText(`${bg(revalued.toFixed(2))} Дт`);
    await expect(page.getByTestId(diff.isPositive() ? 'fx-gain' : 'fx-loss')).toHaveText(
      bg(diff.abs().toFixed(2)),
    );
    await page.getByLabel('Сметка за положителните разлики (финансов приход)').selectOption({
      label: '724 Приходи от курсови разлики',
    });
    await page.getByLabel('Сметка за отрицателните разлики (финансов разход)').selectOption({
      label: '624 Разходи от курсови разлики',
    });
    await page
      .getByLabel('Сметка за отрицателните разлики (финансов разход)')
      .press('Control+Enter');
    await expect(page.getByText(/Преоценката е осчетоводена: статия № 2/)).toBeVisible();
    await page.reload();
    await expect(page.getByText('Позициите вече са по заключителния курс.')).toBeVisible();
    const revalUrl = page.url();

    // The trial balance: 504 closes at the revalued amount.
    await go(page, 't');
    await expect(page.getByRole('row', { name: /504 Разплащателна/ })).toContainText(
      bg(revalued.toFixed(2)),
    );
    await expect(page.getByText('Равнява се')).toBeVisible();

    await checkThemes(page, context, {
      'fx-entry-new': '/journal/new',
      'fx-revaluation': revalUrl,
    });
  });
});
