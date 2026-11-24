import { expect, test, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { checkThemes } from './a11y';
import { OWNER_STATE } from './owner';

test.use({ storageState: OWNER_STATE });

// Account codes and amounts are illustrative test data, not a prescribed chart.

async function period(page: Page, search: string, label: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Alt+P');
  await page.keyboard.type(search);
  await page.keyboard.press('Enter');
  await expect(page.locator('header')).toContainText(label);
}

async function post(page: Page, date: string, rows: [string, 'D' | 'C', string][]) {
  await page.goto('/journal/new');
  const d = page.getByLabel(/Дата/);
  await d.press('Control+A');
  await page.keyboard.type(date);
  await page.keyboard.press('Enter');
  for (const [code, side, amount] of rows) {
    await page.keyboard.type(code);
    await expect(page.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Enter');
    if (side === 'C') await page.keyboard.press('Enter');
    await page.keyboard.type(amount);
    await page.keyboard.press('Enter');
    if (side === 'D') await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
  }
  await page.keyboard.press('Control+Enter');
  await expect(page.getByText(/е осчетоводена/)).toBeVisible();
}

test.describe('BGN → EUR conversion, keyboard only', () => {
  test('add 2025, post in leva, convert, opening balances of 2026', async ({ page, context }) => {
    test.setTimeout(300_000);
    const company = `Евро ${randomBytes(3).toString('hex')} ООД`;
    await page.goto('/companies');
    await page.getByLabel('Наименование').fill(company);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('cell', { name: company, exact: true })).toBeVisible();
    await page.locator('body').press('Control+Shift+K');
    await page.keyboard.type(company);
    await page.keyboard.press('Enter');
    await expect(page.locator('header')).toContainText(company);

    await page.goto('/accounts');
    for (const [code, name] of [
      ['101', 'Основен капитал'],
      ['122', 'Неразпределена печалба'],
      ['421', 'Персонал'],
      ['503', 'Разплащателна сметка'],
      ['604', 'Разходи за заплати'],
      ['624', 'Разходи от курсови разлики'],
      ['724', 'Приходи от курсови разлики'],
    ]) {
      await page.getByLabel('Код').fill(code);
      await page.getByLabel('Наименование').fill(name);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
    }

    // No 2025 yet: the page offers to add it.
    await page.goto('/journal');
    await page.getByRole('link', { name: 'Превалутиране BGN → EUR' }).click();
    await expect(page.getByText('Фирмата няма 2025 г. в лева')).toBeVisible();
    await page.getByRole('button', { name: 'Добави 2025 г. (в лева)' }).press('Enter');
    await expect(page.getByText('2025 г. няма салда')).toBeVisible();
    const conversionUrl = page.url();

    // Two entries in leva in December 2025.
    await period(page, 'дек 2025', 'декември 2025');
    await expect(page.locator('header')).toContainText('BGN');
    await post(page, '10.12', [
      ['503', 'D', '5000'],
      ['101', 'C', '5000'],
    ]);
    await post(page, '31.12', [
      ['604', 'D', '1024,51'],
      ['421', 'C', '1024,51'],
    ]);

    // Conversion: 101 is equity, 421 wages (чл. 45: 523,82364 → 523,83).
    await page.goto(conversionUrl);
    await page.getByLabel('Превалутиране на сметка 101').selectOption('equity');
    await expect(page.getByLabel('Превалутиране на сметка 101')).toHaveValue('equity');
    await page.getByLabel('Превалутиране на сметка 421').selectOption('wages');
    await expect(page.getByTestId('eur-421')).toContainText('523,83 EUR Кт');
    await expect(page.getByTestId('eur-503')).toContainText('2 556,46 EUR Дт');
    await expect(page.getByTestId('eur-604')).toContainText('523,82 EUR Дт');
    // 2556,46 + 523,82 − 2556,46 − 523,83 = −0,01 → a loss of 0,01
    await expect(page.getByTestId('eur-result')).toHaveText('0,01 EUR Дт');
    await expect(page.getByTestId('eur-equity')).toHaveText('0,00 EUR');
    await page.getByLabel('Положителни разлики (текущ приход, чл. 48, ал. 4)').selectOption({
      label: '724 Приходи от курсови разлики',
    });
    await page.getByLabel('Отрицателни разлики (текущ разход, чл. 48, ал. 4)').selectOption({
      label: '624 Разходи от курсови разлики',
    });
    const equity = page.getByLabel('Разлики на собствения капитал (чл. 48, ал. 6)');
    await equity.selectOption({ label: '122 Неразпределена печалба' });
    await equity.press('Control+Enter');
    await expect(page.getByText(/Салдата са превалутирани: статия № 1/)).toBeVisible();
    await page.reload();
    await expect(page.getByText('Салдата на 2025 г. не са се променили след това.')).toBeVisible();

    // January 2026: the converted balances are OPENING balances, and they balance.
    await period(page, 'яну 2026', 'януари 2026');
    await page.goto('/reports/trial-balance');
    await expect(page.getByRole('row', { name: /503 Разплащателна/ })).toContainText('2 556,46');
    await expect(page.getByRole('row', { name: /624 Разходи от курсови/ })).toContainText('0,01');
    await expect(page.getByText('Равнява се')).toBeVisible();

    await checkThemes(page, context, { 'euro-conversion': conversionUrl });
  });
});
