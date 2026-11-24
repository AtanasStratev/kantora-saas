import type { ImportCell, ImportSheet } from '@kantora/domain';
import { strFromU8, unzipSync } from 'fflate';

/**
 * Minimal reader for Office Open XML workbooks (.xlsx), the counterpart of our own writer
 * (ADR-0011, ADR-0017): sheets, shared and inline strings, numbers, booleans and error
 * cells. Formulas are read as their cached values. Untrusted input: the archive is
 * checked before it is expanded (zip bombs), and the cell count is limited.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_CELLS = 2_000_000;

export type Workbook = { sheets: ImportSheet[]; date1904: boolean };
export class XlsxError extends Error {}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e.startsWith('#x')
      ? String.fromCodePoint(parseInt(e.slice(2), 16))
      : e.startsWith('#')
        ? String.fromCodePoint(parseInt(e.slice(1), 10))
        : (ENTITIES[e] ?? ''),
  );
}

const attr = (attrs: string, name: string) =>
  new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];

/** All <t> texts of a string item, without phonetic runs (<rPh>). */
function itemText(xml: string): string {
  const noPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  for (const m of noPhonetic.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) {
    s += unescapeXml(m[1] ?? '');
  }
  return s;
}

/** "AB12" → column index 27 (0-based). */
function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readXlsx(bytes: Uint8Array): Workbook {
  if (bytes.length > MAX_UPLOAD_BYTES) throw new XlsxError('Файлът е по-голям от 10 MB.');
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new XlsxError('Файлът не е във формат .xlsx (Excel 2007 или по-нов).');
  }
  let expanded = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        expanded += f.originalSize;
        if (expanded > MAX_EXPANDED_BYTES)
          throw new XlsxError('Файлът е твърде голям след разархивиране.');
        return (f.name.startsWith('xl/') && f.name.endsWith('.xml')) || f.name.endsWith('.rels');
      },
    });
  } catch (e) {
    if (e instanceof XlsxError) throw e;
    throw new XlsxError('Файлът не може да се отвори като .xlsx.');
  }
  const file = (name: string) => {
    const f = files[name];
    return f ? strFromU8(f) : undefined;
  };
  const workbook = file('xl/workbook.xml');
  if (!workbook) throw new XlsxError('Във файла няма работна книга на Excel.');
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook);

  const rels = new Map<string, string>();
  for (const m of (file('xl/_rels/workbook.xml.rels') ?? '').matchAll(
    /<Relationship\b([^>]*)\/?>/g,
  )) {
    const a = m[1] ?? '';
    const id = attr(a, 'Id');
    const target = attr(a, 'Target');
    if (id && target) {
      rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
    }
  }
  const shared: string[] = [];
  const sst = file('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(itemText(m[1] ?? ''));

  let cells = 0;
  const sheets: ImportSheet[] = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const a = m[1] ?? '';
    const name = unescapeXml(attr(a, 'name') ?? '');
    const target = rels.get(attr(a, 'r:id') ?? '');
    const xml = target ? file(target) : undefined;
    if (!xml) continue;
    const rows: (ImportCell | undefined)[][] = [];
    let nextRow = 0;
    for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = Number(attr(rm[1] ?? '', 'r') ?? nextRow + 1) - 1;
      nextRow = r + 1;
      const row: (ImportCell | undefined)[] = [];
      let nextCol = 0;
      for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        if (++cells > MAX_CELLS) throw new XlsxError('Файлът има твърде много клетки.');
        const ca = cm[1] ?? '';
        const ref = attr(ca, 'r');
        const c = ref ? colIndex(ref) : nextCol;
        nextCol = c + 1;
        const inner = cm[2] ?? '';
        const t = attr(ca, 't') ?? 'n';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let cell: ImportCell | undefined;
        if (t === 'inlineStr') {
          const is = /<is>([\s\S]*?)<\/is>/.exec(inner)?.[1];
          cell = { type: 'text', value: is ? itemText(is) : '' };
        } else if (v === undefined) {
          cell = undefined;
        } else if (t === 's') {
          cell = { type: 'text', value: shared[Number(v)] ?? '' };
        } else if (t === 'str') {
          cell = { type: 'text', value: unescapeXml(v) };
        } else if (t === 'b') {
          cell = { type: 'bool', value: v === '1' ? 'true' : 'false' };
        } else if (t === 'e') {
          cell = { type: 'error', value: unescapeXml(v) };
        } else {
          cell = { type: 'number', value: v.trim() };
        }
        row[c] = cell;
      }
      rows[r] = row;
    }
    sheets.push({ name, rows: Array.from(rows, (r) => r ?? []) });
  }
  return { sheets, date1904 };
}
