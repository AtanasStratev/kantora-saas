import { expect, test, type Page } from '@playwright/test';
import { OWNER_STATE } from './owner';

test.use({ storageState: OWNER_STATE });

async function createCompany(page: Page, name: string, eik = '') {
  await page.goto('/companies');
  await page.getByLabel('Наименование').fill(name);
  if (eik) await page.getByLabel('ЕИК (по желание)').fill(eik);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
}

test.describe('app shell, keyboard only', () => {
  test('companies, palette (Cyrillic/Latin), period switch, help and theme', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // g f → companies
    await page.locator('body').press('g');
    await page.locator('body').press('f');
    await expect(page).toHaveURL('/companies');

    // Invalid EIK is explained; valid companies are created.
    await page.getByLabel('Наименование').fill('Грешен ЕИК ООД');
    await page.getByLabel('ЕИК (по желание)').fill('123');
    await page.keyboard.press('Enter');
    await expect(page.locator('form').getByRole('alert')).toContainText('9 или 13 цифри');
    await createCompany(page, 'Петров ЕООД', '123456789');
    await createCompany(page, 'Щастие АД');

    // Ctrl+Shift+K, search in Latin, Enter
    await page.locator('body').press('Control+Shift+K');
    await page.keyboard.type('shtast');
    await expect(page.locator('[cmdk-item]')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page.locator('header')).toContainText('Щастие АД');

    // Alt+P, Cyrillic month, Enter
    await page.locator('body').press('Alt+P');
    await page.keyboard.type('окт');
    await page.keyboard.press('Enter');
    await expect(page.locator('header')).toContainText('октомври');

    // Ctrl+K finds a company by EIK
    await page.locator('body').press('Control+K');
    await page.keyboard.type('123456');
    await page.keyboard.press('Enter');
    await expect(page.locator('header')).toContainText('Петров ЕООД');

    // ? opens the shortcut list; Esc closes it
    await page.locator('body').press('Shift+Slash');
    const help = page.getByRole('dialog', { name: 'Клавишни комбинации' });
    await expect(help).toBeVisible();
    await expect(help).toContainText('Смяна на фирма');
    await page.keyboard.press('Escape');
    await expect(help).toBeHidden();

    // Alt+T cycles the theme and it survives a reload (stored for the user).
    const html = page.locator('html');
    const before = await html.getAttribute('data-theme');
    await page.locator('body').press('Alt+T');
    await expect(html).not.toHaveAttribute('data-theme', before ?? '');
    const after = await html.getAttribute('data-theme');
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', after ?? '');
  });

  test('the two-key navigation works with a Bulgarian keyboard layout', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Physical G and F keys while the layout types "г" and "ф".
    await page.evaluate(() => {
      const fire = (key: string, code: string) =>
        window.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true }));
      fire('г', 'KeyG');
      fire('ф', 'KeyF');
    });
    await expect(page).toHaveURL('/companies');
  });
});
