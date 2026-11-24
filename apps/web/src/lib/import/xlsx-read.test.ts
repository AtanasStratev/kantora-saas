import { IMPORT_TEMPLATE, parseImportWorkbook } from '@kantora/domain';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { toXlsx } from '../export/xlsx';
import { importTemplateXlsx } from './template';
import { readXlsx } from './xlsx-read';

/** A workbook as Excel writes it: shared strings (with rich text), numbers, gaps. */
function excelLike(): Uint8Array {
  const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>
<row r="3"><c r="A3"><v>401</v></c><c r="B3" t="s"><v>3</v></c><c r="D3" t="b"><v>1</v></c><c r="E3" t="e"><v>#REF!</v></c></row>
<row r="4"><c r="A4" t="str"><f>A3&amp;"0"</f><v>4010</v></c><c r="B4"><v>1234.5599999999999</v></c></row>
</sheetData></worksheet>`;
  const sst = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
<si><t>Код</t></si><si><t>Наименование</t></si>
<si><r><t>Кон</t></r><r><rPr><b/></rPr><t>трагент</t></r><rPh><t>x</t></rPh></si>
<si><t xml:space="preserve">Доставчици &amp; Ко </t></si></sst>`;
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(
      `<workbook xmlns:r="r"><workbookPr date1904="1"/><sheets><sheet name="Сметки" sheetId="1" r:id="rId5"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<Relationships><Relationship Id="rId5" Type="x" Target="/xl/worksheets/sheet7.xml"/></Relationships>`,
    ),
    'xl/worksheets/sheet7.xml': strToU8(sheet),
    'xl/sharedStrings.xml': strToU8(sst),
  });
}

describe('readXlsx', () => {
  it('reads shared and rich strings, numbers, booleans, errors, formulas and gaps', () => {
    const wb = readXlsx(excelLike());
    expect(wb.date1904).toBe(true);
    const s = wb.sheets[0]!;
    expect(s.name).toBe('Сметки');
    expect(s.rows[0]?.map((c) => c?.value)).toEqual([
      'Код',
      'Наименование',
      undefined,
      'Контрагент',
    ]);
    expect(s.rows[1]).toEqual([]);
    expect(s.rows[2]).toEqual([
      { type: 'number', value: '401' },
      { type: 'text', value: 'Доставчици & Ко ' },
      undefined,
      { type: 'bool', value: 'true' },
      { type: 'error', value: '#REF!' },
    ]);
    expect(s.rows[3]?.[0]).toEqual({ type: 'text', value: '4010' });
  });

  it('reads back our own template: every sheet with its headings', () => {
    const wb = readXlsx(importTemplateXlsx());
    expect(wb.sheets.map((s) => s.name)).toEqual([
      'Указания',
      ...Object.values(IMPORT_TEMPLATE).map((t) => t.sheet),
    ]);
    const p = parseImportWorkbook(wb.sheets);
    expect(p.issues).toEqual([]);
    expect(p.ignored).toEqual(['Указания']);
  });

  it('reads our report export (inline strings, numeric amounts)', () => {
    const bytes = toXlsx({
      fileName: 'x',
      sheetName: 'Справка',
      title: 'Т',
      subtitle: 'С',
      columns: [
        { header: 'Сметка', kind: 'text', width: 10 },
        { header: 'Сума', kind: 'amount', width: 10 },
      ],
      rows: [['601', '120.50']],
    });
    const row = readXlsx(bytes).sheets[0]?.rows.find((r) => r[0]?.value === '601');
    expect(row?.[1]).toEqual({ type: 'number', value: '120.50' });
  });

  it('refuses what is not an .xlsx', () => {
    expect(() => readXlsx(strToU8('Код;Наименование'))).toThrow('не е във формат .xlsx');
    expect(() => readXlsx(zipSync({ 'a.txt': strToU8('x') }))).toThrow('няма работна книга');
  });
});
