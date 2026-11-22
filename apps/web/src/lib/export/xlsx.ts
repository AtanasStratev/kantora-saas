import { strToU8, zipSync } from 'fflate';
import { assertTable, type ReportTable } from './table';

/**
 * Minimal Office Open XML workbook (one sheet) written by hand instead of a large
 * spreadsheet library (fewer dependencies, see ADR-0011). Amounts are written as the
 * exact decimal text from the database into numeric cells with the "#,##0.00" format,
 * so Excel shows them in the user's own separators and can sum them.
 */

// Style indexes into cellXfs below.
const S = { text: 0, amount: 1, bold: 2, boldAmount: 3, title: 4, header: 5, headerAmount: 6 };

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
</fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="2"><border/><border><bottom style="thin"/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** XML text: escape markup and drop characters XML 1.0 does not allow. */
export function xmlText(s: string): string {
  return s
    .replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 0 → A, 25 → Z, 26 → AA. */
export function colName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Справка';
}

export function toXlsx(t: ReportTable): Uint8Array {
  assertTable(t);
  const rows: string[] = [];
  const merges: string[] = [];
  let r = 0;
  const textCell = (c: number, v: string, s: number) =>
    v === ''
      ? ''
      : `<c r="${colName(c)}${r}" t="inlineStr" s="${s}"><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
  const numCell = (c: number, v: string, s: number) =>
    v === '' ? '' : `<c r="${colName(c)}${r}" s="${s}"><v>${v}</v></c>`;
  const row = (cells: string) => rows.push(`<row r="${r}">${cells}</row>`);

  r++;
  row(textCell(0, t.title, S.title));
  r++;
  row(textCell(0, t.subtitle, S.text));
  r++; // blank line

  if (t.columns.some((c) => c.group)) {
    r++;
    let cells = '';
    for (let i = 0; i < t.columns.length;) {
      const g = t.columns[i]?.group;
      let j = i;
      while (j + 1 < t.columns.length && g && t.columns[j + 1]?.group === g) j++;
      if (g) {
        cells += textCell(i, g, S.bold);
        if (j > i) merges.push(`${colName(i)}${r}:${colName(j)}${r}`);
      }
      i = j + 1;
    }
    row(cells);
  }
  r++;
  const headerRow = r;
  row(
    t.columns
      .map((c, i) => textCell(i, c.header, c.kind === 'amount' ? S.headerAmount : S.header))
      .join(''),
  );
  for (const data of t.rows) {
    r++;
    row(
      data
        .map((v, i) =>
          t.columns[i]?.kind === 'amount' ? numCell(i, v, S.amount) : textCell(i, v, S.text),
        )
        .join(''),
    );
  }
  if (t.total) {
    r++;
    row(
      t.total
        .map((v, i) =>
          t.columns[i]?.kind === 'amount' ? numCell(i, v, S.boldAmount) : textCell(i, v, S.bold),
        )
        .join(''),
    );
  }
  if (t.note) {
    r += 2;
    row(textCell(0, t.note, S.text));
  }

  const cols = t.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`)
    .join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols}</cols>
<sheetData>${rows.join('')}</sheetData>
${merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}
<pageSetup orientation="${t.columns.length > 5 ? 'landscape' : 'portrait'}" paperSize="9"/>
</worksheet>`;

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlText(sheetName(t.sheetName))}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
    'xl/styles.xml': strToU8(STYLES),
  };
  return zipSync(files, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
}
