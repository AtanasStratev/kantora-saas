import { expect, test, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { checkThemes } from './a11y';
import { OWNER_STATE } from './owner';

test.use({ storageState: OWNER_STATE });

const blur = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

async function go(page: Page, key: string) {
  await blur(page);
  await page.locator('body').press('g');
  await page.locator('body').press(key);
}

/** Adds an account; `needs` are the labels of the analytic checkboxes to tick (Space). */
async function addAccount(page: Page, code: string, name: string, needs: string[] = []) {
  await page.getByLabel('Код').fill(code);
  await page.getByLabel('Наименование').fill(name);
  for (const n of needs) await page.getByRole('checkbox', { name: n, exact: true }).press('Space');
  await page.getByLabel('Наименование').press('Enter');
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
  await expect(page.getByLabel('Код')).toBeFocused();
}

/** Picks the first suggestion of a combobox cell after typing. */
async function pick(page: Page, text: string, option?: RegExp) {
  await page.keyboard.type(text);
  const o = page.getByRole('option').first();
  await expect(o).toBeVisible();
  if (option) await expect(o).toContainText(option);
  await page.keyboard.press('Enter');
}

test.describe('analytics, keyboard only', () => {
  test('counterparties, documents, objects → analytic report → statement', async ({
    page,
    context,
  }) => {
    test.setTimeout(300_000);
    const company = `Аналитики ${randomBytes(3).toString('hex')} ООД`;
    await page.goto('/companies');
    await page.getByLabel('Наименование').fill(company);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('cell', { name: company, exact: true })).toBeVisible();
    await page.locator('body').press('Control+Shift+K');
    await page.keyboard.type(company);
    await page.keyboard.press('Enter');
    await expect(page.locator('header')).toContainText(company);

    // g o → a cost object; g c → a counterparty (no EIK: test data, not a real company).
    await go(page, 'o');
    await expect(page).toHaveURL('/cost-objects');
    await page.getByLabel('Код').fill('СОФ');
    await page.getByLabel('Наименование').fill('Обект София');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('cell', { name: 'Обект София' })).toBeVisible();
    await go(page, 'c');
    await expect(page).toHaveURL('/counterparties');
    await page.getByLabel('Наименование').fill('Алфа ООД');
    await page.getByLabel('ЕИК').fill('12345');
    await page.keyboard.press('Enter');
    await expect(page.getByText('ЕИК е 9 цифри (или 13 за клон).')).toBeVisible();
    await page.getByLabel('ЕИК').fill('');
    await page.getByLabel('Наименование').press('Enter');
    await expect(page.getByRole('link', { name: 'Алфа ООД' })).toBeVisible();

    // g s → accounts with their analytic needs.
    await go(page, 's');
    await addAccount(page, '401', 'Доставчици', ['Контрагент', 'Документ']);
    await addAccount(page, '601', 'Разходи за материали', ['Обект']);
    await addAccount(page, '501', 'Каса');
    await expect(page.getByRole('group', { name: 'Аналитичност на сметка 401' })).toBeVisible();

    // F2: 601 → object; 401 → counterparty, document number and date; Enter skips the
    // analytic cells an account does not need.
    await page.locator('body').press('F2');
    await expect(page).toHaveURL('/journal/new');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Доставка');
    await page.keyboard.press('Enter');
    await pick(page, '601');
    await page.keyboard.type('100');
    await page.keyboard.press('Enter'); // debit → credit
    await page.keyboard.press('Enter'); // credit → object (601 needs it)
    await expect(page.getByLabel('Ред 1, обект')).toBeFocused();
    await pick(page, 'соф', /СОФ/);
    await expect(page.getByLabel('Ред 1, пояснение')).toBeFocused();
    await page.keyboard.press('Enter');
    await pick(page, '401');
    await page.keyboard.press('Enter'); // → credit
    await page.keyboard.type('100');
    await page.keyboard.press('Enter'); // → counterparty
    await expect(page.getByLabel('Ред 2, контрагент')).toBeFocused();
    await expect(page.getByLabel('Ред 2, контрагент')).toHaveAttribute(
      'placeholder',
      'задължително',
    );
    await pick(page, 'alfa', /Алфа ООД/); // Latin search
    await expect(page.getByLabel('Ред 2, номер на документ')).toBeFocused();
    await page.keyboard.type('Ф-100');
    await page.keyboard.press('Enter');
    await page.keyboard.type('5');
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Ред 2, дата на документ')).toHaveValue(/^05\./);
    await page.keyboard.press('Control+Enter');
    await expect(page.getByText(/Статия № 1 от .* е осчетоводена/)).toBeVisible();

    // Missing counterparty: refused with the line and account named.
    await pick(page, '601');
    await page.keyboard.type('40');
    await page.getByLabel('Ред 1, обект').focus();
    await pick(page, 'соф');
    await page.getByLabel('Ред 2, сметка').focus();
    await pick(page, '401');
    await page.keyboard.press('Enter');
    await page.keyboard.type('40');
    await page.getByLabel('Ред 2, номер на документ').fill('Б-7');
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('ul.list-disc')).toContainText(
      'Ред 2: сметка 401 изисква контрагент.',
    );
    // A new counterparty straight from the cell: the dialog takes the typed name.
    await page.getByLabel('Ред 2, контрагент').focus();
    await page.keyboard.type('Бета ЕООД');
    await expect(page.getByRole('option').last()).toHaveText('Нов контрагент „Бета ЕООД“…');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Нов контрагент' });
    await expect(dialog.getByLabel('Наименование')).toHaveValue('Бета ЕООД');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.getByLabel('Ред 2, контрагент')).toHaveValue('Бета ЕООД');
    await expect(page.getByLabel('Ред 2, номер на документ')).toBeFocused();
    await page.keyboard.press('Control+Enter');
    await expect(page.getByText(/Статия № 2 от .* е осчетоводена/)).toBeVisible();

    // Partial payment of Ф-100 from the cash desk.
    await pick(page, '401');
    await page.keyboard.type('30');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await pick(page, 'алфа');
    await page.keyboard.type('Ф-100');
    await page.getByLabel('Ред 2, сметка').focus();
    await pick(page, '501');
    await page.keyboard.press('Enter');
    await page.keyboard.type('30');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByText(/Статия № 3 от .* е осчетоводена/)).toBeVisible();

    // g a → analytic report of 401 by document: Ф-100 has 70,00 left, Б-7 40,00.
    await go(page, 'a');
    await expect(page).toHaveURL(/\/reports\/analytic/);
    await page.getByRole('link', { name: /401 Доставчици/ }).click();
    await expect(page.getByRole('link', { name: 'по документи' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('row', { name: /Алфа ООД · № Ф-100/ })).toContainText('70,00 Кт');
    await expect(page.getByRole('row', { name: /Бета ЕООД · № Б-7/ })).toContainText('40,00 Кт');
    await expect(page.getByTestId('an-total-closing')).toHaveText('110,00 Кт');
    await expect(page.getByRole('status')).toHaveText(
      'Равнява се: сборът на редовете е равен на сметката в оборотната ведомост.',
    );
    const xlsx = await page.request.get(
      (await page.getByRole('link', { name: 'Excel', exact: true }).getAttribute('href')) ?? '',
    );
    const sheet = strFromU8(
      unzipSync(await xlsx.body())['xl/worksheets/sheet1.xml'] ?? new Uint8Array(),
    );
    expect(sheet).toContain('<v>70.00</v>');
    expect(sheet).toContain('Алфа ООД · № Ф-100');
    const analyticUrl = page.url();

    // 601 by object.
    await page.getByRole('link', { name: '← Друга сметка' }).click();
    await page.getByRole('link', { name: /601 Разходи/ }).click();
    await expect(page.getByRole('row', { name: /СОФ Обект София/ })).toContainText('140,00 Дт');

    // Statement of Алфа: 100 credit, 30 debit on 401.
    await page.goto(analyticUrl);
    await page.getByRole('link', { name: /Алфа ООД · № Ф-100/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Извлечение — Алфа ООД');
    await expect(page.getByTestId('st-401')).toContainText('70,00 Кт');
    const statementUrl = page.url();
    const pdf = await page.request.get(
      (await page.getByRole('link', { name: 'PDF' }).getAttribute('href')) ?? '',
    );
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

    // The trial balance agrees: 401 closes at 110,00 credit.
    await go(page, 't');
    await expect(page.getByRole('row', { name: /401 Доставчици/ })).toContainText('110,00');

    await checkThemes(page, context, {
      'analytics-entry-new': '/journal/new',
      'analytics-accounts': '/accounts',
      'analytics-counterparties': '/counterparties',
      'analytics-cost-objects': '/cost-objects',
      'analytics-report': analyticUrl,
      'analytics-statement': statementUrl,
    });
  });
});
