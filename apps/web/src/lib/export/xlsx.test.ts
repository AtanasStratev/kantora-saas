import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { assertTable, contentDisposition, type ReportTable } from './table';
import { colName, toXlsx, xmlText } from './xlsx';

const table: ReportTable = {
  fileName: 'oborotna-vedomost-2025-12',
  sheetName: 'Оборотна ведомост',
  title: 'Оборотна ведомост — „Алфа & Бета“ <ООД>',
  subtitle: 'дек 2025 · в BGN',
  columns: [
    { header: 'Сметка', kind: 'text', width: 10 },
    { header: 'Наименование', kind: 'text', width: 30 },
    { header: 'Дебит', group: 'Обороти', kind: 'amount', width: 14 },
    { header: 'Кредит', group: 'Обороти', kind: 'amount', width: 14 },
  ],
  rows: [
    ['401', 'Доставчици', '', '1234567890123.45'],
    ['601', 'Разходи за материали', '1234567890123.45', ''],
  ],
  total: ['Общо', '', '1234567890123.45', '1234567890123.45'],
  note: 'Равнява се.',
};

describe('xlsx writer', () => {
  const files = unzipSync(toXlsx(table));
  const sheet = strFromU8(files['xl/worksheets/sheet1.xml'] ?? new Uint8Array());

  it('has the parts Excel requires', () => {
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    expect(strFromU8(files['xl/workbook.xml'] ?? new Uint8Array())).toContain(
      'name="Оборотна ведомост"',
    );
  });

  it('writes amounts as the exact decimal text, in numeric cells with a money format', () => {
    // 15 significant digits: a JS number would already round here.
    expect(sheet).toContain('<c r="D6" s="1"><v>1234567890123.45</v></c>');
    expect(sheet).toContain('<c r="C8" s="3"><v>1234567890123.45</v></c>');
    expect(sheet).not.toMatch(/<v>[^<]*e[+-]/i);
  });

  it('escapes text and merges the group header', () => {
    expect(sheet).toContain('„Алфа &amp; Бета“ &lt;ООД&gt;');
    expect(sheet).toContain('<mergeCell ref="C4:D4"/>');
    expect(sheet).toContain('ySplit="5"');
  });

  it('refuses a malformed amount instead of writing a wrong figure', () => {
    expect(() => toXlsx({ ...table, rows: [['1', 'x', '1 234,50', '']] })).toThrow(
      /not a decimal amount/,
    );
    expect(() => assertTable({ ...table, rows: [['1', 'x']] })).toThrow(/2 cells, expected 4/);
  });

  it('helpers', () => {
    expect([0, 25, 26, 51, 52, 701].map(colName)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ']);
    expect(xmlText('a\u0001b"<')).toBe('ab&quot;&lt;');
    expect(contentDisposition('картон-601', 'pdf')).toBe(
      `attachment; filename="601.pdf"; filename*=UTF-8''${encodeURIComponent('картон-601.pdf')}`,
    );
  });

  // A real file for opening in Excel/LibreOffice by hand (not compared byte by byte).
  it('writes a sample for manual inspection', () => {
    const dir = join(process.cwd(), 'test-results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sample.xlsx'), toXlsx(table));
  });
});
