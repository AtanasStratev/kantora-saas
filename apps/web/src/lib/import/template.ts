import { IMPORT_TEMPLATE } from '@kantora/domain';
import { strToU8, zipSync } from 'fflate';
import { colName, xmlText } from '../export/xlsx';

/**
 * The empty import template (ADR-0017): an instructions sheet, then one sheet per kind of
 * data with the column headings the importer looks for. Examples are only on the
 * instructions sheet, so a template filled in by the user never imports them by mistake.
 */
const INSTRUCTIONS: string[][] = [
  ['Шаблон за внос в Кантора'],
  [''],
  [
    'Попълнете само листовете, които ви трябват; празните се пропускат. Колоните се търсят по заглавие, редът им няма значение.',
  ],
  [
    'Преди запис програмата показва какво ще внесе и всички грешки с лист и ред. Записва се всичко или нищо.',
  ],
  [''],
  [
    'Сметки',
    'Код и наименование. Групова, Контрагент, Документ, Обект, Валутна: „да“ или празно. Превалутиране: обикновено, капитал или възнаграждения.',
  ],
  [
    'Контрагенти',
    'Наименование; ЕИК (9 или 13 цифри), ДДС номер (напр. BG123456789), държава (BG), адрес — по желание.',
  ],
  ['Обекти', 'Код и наименование.'],
  [
    'Начални салда',
    'Салдата към първия ден на избраната година: сметка и сума в дебит или в кредит, с аналитичността на сметката.',
  ],
  [
    'Статии',
    'Всеки ред е ред на статия; редовете с еднакъв номер в колоната „Статия“ са една статия. Дата: 15.11.2026 или дата от Excel.',
  ],
  [''],
  ['Пример за статия (на листа „Статии“ без този ред):'],
  ['Статия', 'Дата', 'Основание', 'Сметка', 'Дебит', 'Кредит', 'Контрагент', 'Документ №'],
  ['1', '15.11.2026', 'Доставка на материали', '601', '120,50', '', '', ''],
  [
    '1',
    '15.11.2026',
    'Доставка на материали',
    '401',
    '',
    '120,50',
    'ЕИК или наименование',
    'Ф-123',
  ],
  [''],
  [
    'Сумите са в отчетната валута на годината (лева до 2025 г., евро от 2026 г.), с до 2 знака след запетаята.',
  ],
];

export function importTemplateXlsx(): Uint8Array {
  const sheets: { name: string; rows: string[][]; widths: number[]; header: boolean }[] = [
    { name: 'Указания', rows: INSTRUCTIONS, widths: [16, 110], header: false },
    ...Object.values(IMPORT_TEMPLATE).map((t) => ({
      name: t.sheet,
      rows: [[...t.columns]],
      widths: t.columns.map((c) => Math.max(12, c.length + 4)),
      header: true,
    })),
  ];
  const sheetXml = (s: (typeof sheets)[number]) => {
    const rows = s.rows
      .map(
        (r, i) =>
          `<row r="${i + 1}">${r
            .map((v, j) =>
              v === ''
                ? ''
                : `<c r="${colName(j)}${i + 1}" t="inlineStr" s="${i === 0 ? 1 : 0}"><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`,
            )
            .join('')}</row>`,
      )
      .join('');
    const cols = s.widths
      .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
      .join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${s.header ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : ''}
<cols>${cols}</cols><sheetData>${rows}</sheetData></worksheet>`;
  };
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    'xl/styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`),
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s));
  });
  return zipSync(files, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
}
