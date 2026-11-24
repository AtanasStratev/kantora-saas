import { expect, test, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { checkThemes } from './a11y';
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

test.describe('ledger, keyboard only', () => {
  test('accounts → entry → trial balance → reversal → locked period', async ({
    page,
    context,
    playwright,
  }) => {
    test.setTimeout(300_000);
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

    // Template: save rows with "0" (side only), load with F4, type the amount, post.
    await page.goto('/journal/new');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await typeRow(page, '601', '0', 'D');
    await typeRow(page, '401', '0', 'C');
    await page.getByRole('button', { name: 'Запази като шаблон…' }).click();
    const save = page.getByRole('dialog', { name: 'Запазване като шаблон' });
    await save.getByLabel('Име на шаблона').fill('Материали от доставчик');
    await page.keyboard.press('Enter');
    await expect(save).toBeHidden();
    await expect(page.getByText('Шаблонът „Материали от доставчик“ е запазен.')).toBeVisible();

    await page.goto('/journal/new');
    await page.locator('body').press('F4');
    await page.keyboard.type('матер');
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Ред 1, сметка')).toHaveValue('601 Разходи за материали');
    await expect(page.getByLabel('Ред 1, дебит')).toBeFocused();
    await page.keyboard.type('75');
    await page.getByLabel('Ред 2, кредит').focus();
    await page.keyboard.press('F9');
    await expect(page.getByTestId('balance-status')).toHaveText('Дт = Кт');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByText(/Статия № 3 от .* е осчетоводена/)).toBeVisible();
    await page.goto('/journal/templates');
    await expect(page.getByRole('heading', { name: 'Материали от доставчик' })).toBeVisible();

    // Export: the files carry the same figures as the screen.
    await page.goto('/reports/trial-balance');
    await expect(page.getByTestId('tb-total-2')).toHaveText('316,00');
    const xlsxLink = page.getByRole('link', { name: 'Excel', exact: true });
    await xlsxLink.focus();
    const downloading = page.waitForEvent('download');
    await page.keyboard.press('Enter');
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^oborotna-vedomost-\d{4}-\d{2}\.xlsx$/);
    const xlsx = await page.request.get((await xlsxLink.getAttribute('href')) ?? '');
    expect(xlsx.headers()['content-type']).toContain('spreadsheetml');
    const sheet = strFromU8(
      unzipSync(await xlsx.body())['xl/worksheets/sheet1.xml'] ?? new Uint8Array(),
    );
    expect(sheet).toContain('<v>316.00</v>');
    expect(sheet).toContain('Разходи за материали');
    const pdf = await page.request.get(
      (await page.getByRole('link', { name: 'PDF' }).getAttribute('href')) ?? '',
    );
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
    // Without a session the export answers with a redirect to the login page, no file.
    const anonymous = await playwright.request.newContext({
      baseURL: 'http://localhost:3000',
      storageState: { cookies: [], origins: [] },
    });
    const anon = await anonymous.get('/export/trial-balance?format=xlsx', { maxRedirects: 0 });
    expect(anon.status()).toBe(307);
    expect(anon.headers()['location']).toContain('/login');
    await anonymous.dispose();

    const cardUrl = await page.getByRole('link', { name: /601/ }).getAttribute('href');

    // General ledger (g l) and chronological register (g r): same turnover as the trial balance.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator('body').press('g');
    await page.locator('body').press('l');
    await expect(page).toHaveURL(/\/reports\/general-ledger/);
    await expect(page.getByTestId('gl-total-d')).toHaveText('316,00');
    await expect(page.getByTestId('gl-total-c')).toHaveText('316,00');
    const gl601 = page.getByTestId('gl-601');
    await expect(gl601.getByRole('rowheader')).toContainText('601 Разходи за материали');
    // 120,50 debit, reversed by 120,50 credit, then 75,00 from the template: 75,00 Дт.
    await expect(gl601.getByRole('row').last()).toContainText('75,00 Дт');
    await expect(page.getByRole('status')).toHaveText('Равнява се: общо дебит = общо кредит.');
    const glPdf = await page.request.get(
      (await page.getByRole('link', { name: 'PDF' }).getAttribute('href')) ?? '',
    );
    expect((await glPdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

    await page.locator('body').press('g');
    await page.locator('body').press('r');
    await expect(page).toHaveURL(/\/reports\/register/);
    await expect(page.getByTestId('reg-total-d')).toHaveText('316,00');
    await expect(page.getByTestId('reg-total-c')).toHaveText('316,00');
    await expect(page.getByText('Сторно на статия № 1').first()).toBeVisible();
    const regXlsx = await page.request.get(
      (await page.getByRole('link', { name: 'Excel', exact: true }).getAttribute('href')) ?? '',
    );
    const regSheet = strFromU8(
      unzipSync(await regXlsx.body())['xl/worksheets/sheet1.xml'] ?? new Uint8Array(),
    );
    expect(regSheet).toContain('<v>316.00</v>');
    expect(regSheet).toContain('Сторно на статия № 1');
    await checkThemes(page, context, {
      'ledger-entry-new': '/journal/new',
      'ledger-journal': '/journal',
      'ledger-entry': entryUrl,
      'ledger-trial-balance': '/reports/trial-balance',
      'ledger-account-card': cardUrl ?? '/reports/trial-balance',
      'ledger-general-ledger': '/reports/general-ledger',
      'ledger-register': '/reports/register',
      'ledger-accounts': '/accounts',
      'ledger-templates': '/journal/templates',
    });
  });
});
