import { expect, test } from '@playwright/test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { randomBytes } from 'node:crypto';
import { checkThemes } from './a11y';
import { OWNER_STATE } from './owner';

test.use({ storageState: OWNER_STATE });

// Account codes, names and amounts are illustrative test data.
const YEAR = new Date().getFullYear();

/** A minimal .xlsx with inline-string cells, one sheet per entry of `sheets`. */
function xlsx(sheets: Record<string, string[][]>): Buffer {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const col = (i: number) => String.fromCharCode(65 + i);
  const names = Object.keys(sheets);
  const files: Record<string, Uint8Array> = {
    'xl/workbook.xml': strToU8(
      `<workbook xmlns:r="r"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<Relationships>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/s${i + 1}.xml"/>`).join('')}</Relationships>`,
    ),
  };
  names.forEach((n, i) => {
    const rows = (sheets[n] ?? [])
      .map(
        (r, k) =>
          `<row r="${k + 1}">${r.map((v, j) => (v === '' ? '' : `<c r="${col(j)}${k + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`)).join('')}</row>`,
      )
      .join('');
    files[`xl/worksheets/s${i + 1}.xml`] = strToU8(
      `<worksheet><sheetData>${rows}</sheetData></worksheet>`,
    );
  });
  return Buffer.from(zipSync(files));
}

const book = (payAccount: string) => ({
  Сметки: [
    ['Код', 'Наименование', 'Контрагент', 'Документ'],
    ['101', 'Основен капитал', '', ''],
    ['401', 'Доставчици', 'да', 'да'],
    ['503', 'Разплащателна сметка', '', ''],
    ['601', 'Разходи за материали', '', ''],
  ],
  Контрагенти: [['Наименование'], ['Доставчик А']],
  'Начални салда': [
    ['Сметка', 'Дебит', 'Кредит'],
    ['503', '5 000,00', ''],
    ['101', '', '5 000,00'],
  ],
  Статии: [
    ['Статия', 'Дата', 'Основание', 'Сметка', 'Дебит', 'Кредит', 'Контрагент', 'Документ №'],
    ['1', `03.02.${YEAR}`, 'Материали', '601', '300', '', '', ''],
    ['1', `03.02.${YEAR}`, 'Материали', '401', '', '300', 'Доставчик А', 'Ф-1'],
    ['2', `10.02.${YEAR}`, 'Плащане', '401', '300', '', 'Доставчик А', 'Ф-1'],
    ['2', `10.02.${YEAR}`, 'Плащане', payAccount, '', '300', '', ''],
  ],
});

test.describe('import from Excel, keyboard first', () => {
  test('template, a file with a mistake, the corrected file, the trial balance', async ({
    page,
    context,
  }) => {
    test.setTimeout(300_000);
    const company = `Внос ${randomBytes(3).toString('hex')} ООД`;
    await page.goto('/companies');
    await page.getByLabel('Наименование').fill(company);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('cell', { name: company, exact: true })).toBeVisible();
    await page.locator('body').press('Control+Shift+K');
    await page.keyboard.type(company);
    await page.keyboard.press('Enter');
    await expect(page.locator('header')).toContainText(company);

    // g i → the import page; the template downloads with all its sheets.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator('body').press('g');
    await page.locator('body').press('i');
    await expect(page).toHaveURL('/import');
    const tpl = await page.request.get('/import-template');
    expect(tpl.headers()['content-type']).toContain('spreadsheetml');
    const workbook = strFromU8(unzipSync(await tpl.body())['xl/workbook.xml'] ?? new Uint8Array());
    for (const name of ['Указания', 'Сметки', 'Контрагенти', 'Обекти', 'Начални салда', 'Статии']) {
      expect(workbook).toContain(`name="${name}"`);
    }

    // A file with a mistake: account 999 does not exist. Nothing is written.
    const file = page.getByLabel('Файл (.xlsx, до 10 MB)');
    await file.setInputFiles({
      name: 'grreshka.xlsx',
      mimeType: 'application/octet-stream',
      buffer: xlsx(book('999')),
    });
    await file.press('Control+Enter');
    const problems = page.getByRole('table', { name: 'Проблеми във файла' });
    await expect(problems.getByRole('row', { name: /Статии 5 Няма сметка 999/ })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Файлът не е внесен: 1 проблем.');
    await expect(page.getByRole('button', { name: /Внеси/ })).toHaveCount(0);

    // The corrected file: check, then import with Ctrl+Enter.
    await file.setInputFiles({
      name: 'vnos.xlsx',
      mimeType: 'application/octet-stream',
      buffer: xlsx(book('503')),
    });
    await file.press('Control+Enter');
    await expect(page.getByRole('status')).toHaveText(
      'Проверката мина. Нищо не е записано; натиснете „Внеси“.',
    );
    await expect(page.getByTestId('imp-accounts')).toHaveText('4 нови, 0 вече има');
    await expect(page.getByTestId('imp-opening')).toHaveText(`2 реда към 01.01.${YEAR}`);
    await expect(page.getByTestId('imp-entries')).toHaveText(`2 (03.02.${YEAR} – 10.02.${YEAR})`);
    await file.press('Control+Enter');
    await expect(page.getByRole('status')).toHaveText('Файлът е внесен.');
    await expect(page.getByText(/vnos\.xlsx · начални салда · 2 статии/)).toBeVisible();

    // The trial balance for the year: opening 5000 on 503, minus the 300 paid.
    await page.goto('/reports/trial-balance?from=1&to=12');
    await expect(page.getByRole('row', { name: /503 Разплащателна сметка/ })).toContainText(
      '4 700,00',
    );
    await expect(page.getByText('Равнява се')).toBeVisible();

    await checkThemes(page, context, { import: '/import' });
  });
});
