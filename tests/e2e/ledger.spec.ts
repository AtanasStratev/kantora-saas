import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { OWNER_STATE } from './owner';

test.use({ storageState: OWNER_STATE });

async function addAccount(page: Page, code: string, name: string) {
  await page.getByLabel('Код').fill(code);
  await page.getByLabel('Наименование').fill(name);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
  // The form puts the cursor back in the code field for the next account.
  await expect(page.getByLabel('Код')).toBeFocused();
}

/** Types one grid row with the keyboard only: account search, Enter, amount, Enter… */
async function typeRow(page: Page, search: string, amount: string, side: 'D' | 'C') {
  await page.keyboard.type(search);
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('Enter'); // pick the account → debit cell
  if (side === 'C') await page.keyboard.press('Enter'); // → credit cell
  await page.keyboard.type(amount);
  await page.keyboard.press('Enter');
  if (side === 'D') await page.keyboard.press('Enter'); // credit → memo
  await page.keyboard.press('Enter'); // memo → next row's account
}

/** axe (WCAG 2.2 AA) and a screenshot of each ledger screen in the three themes. */
async function checkThemes(page: Page, context: BrowserContext, screens: Record<string, string>) {
  for (const theme of ['light', 'dark', 'black'] as const) {
    await context.addCookies([
      { name: 'kantora-theme', value: theme, url: 'http://localhost:3000' },
    ]);
    for (const [name, url] of Object.entries(screens)) {
      await page.goto(url);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('main')).not.toBeEmpty();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      const violations = results.violations.map(
        (v) => `${name}: ${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      );
      expect(violations).toEqual([]);
      await page.screenshot({ path: `test-results/screens/${name}-${theme}.png`, fullPage: true });
    }
  }
}

test.describe('ledger, keyboard only', () => {
  test('accounts → entry → trial balance → reversal → locked period', async ({ page, context }) => {
    test.setTimeout(240_000);
    const company = `Леджър ${randomBytes(3).toString('hex')} ООД`;
    await page.goto('/companies');
    await page.getByLabel('Наименование').fill(company);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('cell', { name: company, exact: true })).toBeVisible();
    await page.locator('body').press('Control+Shift+K');
    await page.keyboard.type(company);
    await page.keyboard.press('Enter');
    await expect(page.locator('header')).toContainText(company);

    // g s → chart of accounts
    await page.locator('body').press('g');
    await page.locator('body').press('s');
    await expect(page).toHaveURL('/accounts');
    await addAccount(page, '401', 'Доставчици');
    await addAccount(page, '601', 'Разходи за материали');

    // F2 → new entry. One unbalanced attempt is refused, then F9 balances it.
    await page.locator('body').press('F2');
    await expect(page).toHaveURL('/journal/new');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Материали');
    await page.keyboard.press('Enter');
    await typeRow(page, '601', '120,50', 'D');
    await page.keyboard.type('dost'); // Latin search finds "Доставчици"
    await expect(page.getByRole('option')).toContainText('401');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('100');
    const status = page.getByTestId('balance-status');
    await expect(status).toContainText('Разлика 20,50 по дебита');
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('ul.list-disc')).toContainText('Разлика 20,50');
    await page.keyboard.press('F9');
    await expect(status).toHaveText('Дт = Кт');
    await expect(page.getByTestId('total-credit')).toHaveText('120,50');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByText(/Статия № 1 от .* е осчетоводена/)).toBeVisible();

    // g t → trial balance reconciles and shows the figures. Letters type into a field,
    // so leave the grid first.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator('body').press('g');
    await page.locator('body').press('t');
    await expect(page).toHaveURL(/\/reports\/trial-balance/);
    await expect(page.getByRole('row', { name: /601 Разходи за материали/ })).toContainText(
      '120,50',
    );
    await expect(page.getByText('Равнява се')).toBeVisible();

    // Drill down into the account card, then into the entry, and reverse it with F8.
    await page.getByRole('link', { name: /601/ }).click();
    await expect(page.getByRole('heading')).toContainText('Картон на сметка 601');
    await page.getByRole('link', { name: '1', exact: true }).click();
    await expect(page.getByRole('heading')).toContainText('Статия № 1');
    await page.locator('body').press('F8');
    const reverse = page.getByRole('dialog');
    await expect(reverse).toContainText('Сторно на статия № 1');
    await reverse.getByRole('button', { name: 'Сторнирай' }).press('Enter');
    await expect(page.getByRole('heading')).toContainText('Статия № 2');

    const entryUrl = page.url();
    // The account balance is back to zero.
    await page.goto('/reports/trial-balance');
    await expect(page.getByRole('row', { name: /^Общо/ })).toContainText('241,00');

    // Lock the period: new entries are refused, then unlock again.
    await page.goto('/journal');
    await expect(page.getByRole('cell', { name: 'Сторниран' })).toBeVisible();
    await page.getByRole('button', { name: 'Заключи периода…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Заключи' }).click();
    await expect(page.getByRole('button', { name: 'Отключи периода…' })).toBeVisible();
    await page.goto('/journal/new');
    await expect(page.getByText(/е заключен/)).toBeVisible();
    await page.goto('/journal');
    await page.getByRole('button', { name: 'Отключи периода…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Отключи' }).click();
    await expect(page.getByRole('link', { name: 'Нова статия (F2)' })).toBeVisible();

    await page.goto('/reports/trial-balance');
    const cardUrl = await page.getByRole('link', { name: /601/ }).getAttribute('href');
    await checkThemes(page, context, {
      'ledger-entry-new': '/journal/new',
      'ledger-journal': '/journal',
      'ledger-entry': entryUrl,
      'ledger-trial-balance': '/reports/trial-balance',
      'ledger-account-card': cardUrl ?? '/reports/trial-balance',
      'ledger-accounts': '/accounts',
    });
  });
});
