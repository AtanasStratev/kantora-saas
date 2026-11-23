/**
 * One report as plain data: what the screen shows is what Excel and PDF get (phase 2
 * step 7, "износ на видимото"). Amounts are DECIMAL STRINGS ("1234.50") straight from
 * PostgreSQL numeric / decimal.js; they are never turned into JS numbers here.
 */
export type Column = {
  header: string;
  /** Header shown above a run of adjacent columns with the same group (e.g. "Обороти"). */
  group?: string;
  kind: 'text' | 'amount';
  /** Relative width (Excel characters; scaled to the page in PDF). */
  width: number;
};

export type ReportTable = {
  /** File name without extension: letters, digits, dash. */
  fileName: string;
  sheetName: string;
  title: string;
  /** Company, period, currency: everything needed to read the figures correctly. */
  subtitle: string;
  columns: Column[];
  rows: string[][];
  /** Indices into `rows` shown in bold (section headers and subtotals of the general ledger). */
  strong?: number[];
  total?: string[];
  /** A closing line, e.g. the reconciliation result. */
  note?: string;
};

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** Throws on a malformed table: better no file than a file with wrong figures. */
export function assertTable(t: ReportTable): void {
  const n = t.columns.length;
  for (const [i, r] of [...t.rows, ...(t.total ? [t.total] : [])].entries()) {
    if (r.length !== n) throw new Error(`report row ${i} has ${r.length} cells, expected ${n}`);
    r.forEach((v, j) => {
      if (t.columns[j]?.kind === 'amount' && v !== '' && !DECIMAL.test(v)) {
        throw new Error(`report row ${i} column ${j}: "${v}" is not a decimal amount`);
      }
    });
  }
}

/** ASCII-safe file name; the Bulgarian name goes in Content-Disposition filename*. */
export function contentDisposition(fileName: string, ext: 'xlsx' | 'pdf'): string {
  const ascii = fileName.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${fileName}.${ext}`)}`;
}
