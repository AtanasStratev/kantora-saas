import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { checkThemes } from './a11y';
import { OWNER_STATE } from './owner';

test.use({ storageState: OWNER_STATE });

// Account codes are illustrative test data. No VAT rate is in the program until the text
// of ЗДДС is in docs/legal/vat, so posting must be refused honestly (ADR-0018); the
// posting itself is covered by packages/db/src/vat.int.test.ts with a fictitious rate.
test.describe('VAT documents, keyboard first', () => {
  test('settings, the document form without verified rates, three themes', async ({
    page,
    context,
  }) => {
    test.setTimeout(300_000);
    const company = `ДДС ${randomBytes(3).toString('hex')} ООД`;
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
      ['401', 'Доставчици'],
      ['4531', 'Начислен ДДС за покупките'],
      ['601', 'Разходи за материали'],
    ]) {
      await page.getByLabel('Код').fill(code);
      await page.getByLabel('Наименование').fill(name);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
    }

    // g v → the documents of the period; the settings choose the accounts.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator('body').press('g');
    await page.locator('body').press('v');
    await expect(page).toHaveURL('/vat');
    await expect(page.getByText('Няма документи за периода')).toBeVisible();
    await page.getByRole('link', { name: 'Настройки на ДДС' }).click();
    await page.getByLabel('Доставчици (покупки)').selectOption({ label: '401 Доставчици' });
    await page
      .getByLabel('ДДС за покупките')
      .selectOption({ label: '4531 Начислен ДДС за покупките' });
    await page.getByRole('button', { name: 'Запази' }).press('Enter');
    await expect(page.getByText('Настройките са запазени.')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Доставчици (покупки)')).toHaveValue(/.+/);

    // The form: without a verified rate it says so and does not post.
    await page.goto('/vat/new');
    await expect(page.getByLabel('Покупка или продажба')).toBeFocused();
    await expect(page.getByRole('alert')).toContainText(
      'Няма въведени ставки на ДДС от официален източник',
    );
    await expect(page.getByRole('button', { name: /Осчетоводи/ })).toBeDisabled();
    await page.getByLabel('Ред 1, сметка').selectOption({ label: '601 Разходи за материали' });
    await page.getByLabel('Ред 1, данъчна основа').fill('100');
    await page.getByLabel('Ред 1, данъчна основа').press('Tab');
    await expect(page.getByLabel('Ред 1, данъчна основа')).toHaveValue('100,00');
    await expect(page.getByTestId('vat-net')).toHaveText('100,00');

    await checkThemes(page, context, {
      'vat-list': '/vat',
      'vat-settings': '/vat/settings',
      'vat-new': '/vat/new',
    });
  });
});
