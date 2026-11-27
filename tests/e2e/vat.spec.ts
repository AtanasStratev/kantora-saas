import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { checkThemes } from './a11y';
import { OWNER_STATE } from './owner';

test.use({ storageState: OWNER_STATE });

// Account codes and the counterparty are illustrative test data. The VAT rate is the one
// stored from ЗДДС чл. 66, ал. 1 (migration 20261129100000, source in docs/legal/vat).
test.describe('VAT documents, keyboard first', () => {
  test('settings, a purchase invoice at the standard rate, three themes', async ({
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

    // A counterparty for the invoice (fictitious test data).
    await page.goto('/counterparties');
    await page.getByLabel('Наименование').fill('Доставчик А');
    await page.getByLabel('Наименование').press('Enter');
    await expect(page.getByRole('link', { name: 'Доставчик А' })).toBeVisible();

    // A purchase invoice at the standard rate (ЗДДС чл. 66, ал. 1, from legal_parameter).
    await page.goto('/vat/new');
    await expect(page.getByLabel('Покупка или продажба')).toBeFocused();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Няма въведени ставки на ДДС' }),
    ).toHaveCount(0);
    await page.getByLabel('Контрагент').selectOption({ label: 'Доставчик А' });
    await page.getByLabel('Номер на документа').fill('0000000123');
    await page.getByLabel('Ред 1, сметка').selectOption({ label: '601 Разходи за материали' });
    await page.getByLabel('Ред 1, данъчна основа').fill('100');
    await page.getByLabel('Ред 1, данъчна основа').press('Tab');
    await expect(page.getByLabel('Ред 1, данъчна основа')).toHaveValue('100,00');
    await page.getByLabel('Ред 1, ставка').selectOption({ label: '20 %' });
    await expect(page.getByLabel('Ред 1, ДДС')).toHaveValue('20,00');
    await expect(page.getByTestId('vat-gross')).toHaveText('120,00');
    await page.getByLabel('Ред 1, ДДС').press('Control+Enter');
    await expect(
      page.getByText(/Фактура № 0000000123 е осчетоводен\(а\): статия № 1\./),
    ).toBeVisible();

    await page.goto('/vat');
    const row = page.getByRole('row', { name: /Фактура № 0000000123/ });
    await expect(row).toContainText('Доставчик А');
    await expect(row).toContainText('100,00');
    await expect(row).toContainText('20,00');

    await checkThemes(page, context, {
      'vat-list': '/vat',
      'vat-settings': '/vat/settings',
      'vat-new': '/vat/new',
    });
  });
});
