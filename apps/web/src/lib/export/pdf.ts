import 'server-only';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { formatAmount } from '@kantora/domain';
import PDFDocument from 'pdfkit';
import { assertTable, type ReportTable } from './table';

/**
 * A4 PDF of a report table: title, subtitle, table with the header repeated on every page,
 * total row, note, and "стр. N от M" with the generation time. DejaVu Sans covers Latin and
 * Cyrillic; the font files are embedded (subset), so the PDF reads the same everywhere.
 */
const fonts = (() => {
  // Resolve from the app's own package.json: works in dev, in the build and in tests.
  const req = createRequire(join(process.cwd(), 'package.json'));
  return {
    regular: req.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'),
    bold: req.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf'),
  };
})();

const MARGIN = 36;
const ROW_H = 14;
const SIZE = 8;

export async function toPdf(t: ReportTable, generatedAt: Date): Promise<Uint8Array> {
  assertTable(t);
  const landscape = t.columns.length > 5;
  const doc = new PDFDocument({
    size: 'A4',
    layout: landscape ? 'landscape' : 'portrait',
    margin: MARGIN,
    bufferPages: true,
    font: fonts.regular,
    info: { Title: t.title, Subject: t.subtitle, Producer: 'Кантора' },
  });
  doc.registerFont('R', fonts.regular);
  doc.registerFont('B', fonts.bold);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', reject);
  });

  const usable = doc.page.width - 2 * MARGIN;
  const weight = t.columns.reduce((s, c) => s + c.width, 0);
  const widths = t.columns.map((c) => (c.width / weight) * usable);
  const xs = widths.map((_, i) => MARGIN + widths.slice(0, i).reduce((s, w) => s + w, 0));
  const bottom = () => doc.page.height - MARGIN - 18; // room for the footer
  const cellText = (v: string, i: number) =>
    t.columns[i]?.kind === 'amount' && v !== '' ? formatAmount(v) : v;

  let y = MARGIN;
  const line = (yy: number, width = 0.5) =>
    doc
      .moveTo(MARGIN, yy)
      .lineTo(MARGIN + usable, yy)
      .lineWidth(width)
      .stroke();

  function drawRow(cells: string[], font: 'R' | 'B', header = false) {
    doc.font(font).fontSize(SIZE);
    cells.forEach((v, i) => {
      const amount = t.columns[i]?.kind === 'amount';
      doc.text(header ? v : cellText(v, i), (xs[i] ?? 0) + 2, y + 3, {
        width: (widths[i] ?? 0) - 4,
        height: ROW_H,
        align: amount ? 'right' : 'left',
        lineBreak: false,
        ellipsis: true,
      });
    });
    y += ROW_H;
  }

  function drawHeader() {
    if (t.columns.some((c) => c.group)) {
      doc.font('B').fontSize(SIZE);
      for (let i = 0; i < t.columns.length;) {
        const g = t.columns[i]?.group;
        let j = i;
        while (j + 1 < t.columns.length && g && t.columns[j + 1]?.group === g) j++;
        if (g) {
          const w = widths.slice(i, j + 1).reduce((s, x) => s + x, 0);
          doc.text(g, xs[i] ?? 0, y + 3, { width: w, align: 'center', lineBreak: false });
        }
        i = j + 1;
      }
      y += ROW_H;
    }
    drawRow(
      t.columns.map((c) => c.header),
      'B',
      true,
    );
    line(y, 0.8);
  }

  doc.font('B').fontSize(13).text(t.title, MARGIN, y, { width: usable });
  y = doc.y + 2;
  doc.font('R').fontSize(9).text(t.subtitle, MARGIN, y, { width: usable });
  y = doc.y + 10;
  drawHeader();

  const strong = new Set(t.strong);
  for (const [k, r] of t.rows.entries()) {
    if (y + ROW_H > bottom()) {
      doc.addPage();
      y = MARGIN;
      drawHeader();
    }
    drawRow(r, strong.has(k) ? 'B' : 'R');
    line(y, 0.2);
  }
  if (t.total) {
    if (y + ROW_H > bottom()) {
      doc.addPage();
      y = MARGIN;
      drawHeader();
    }
    line(y, 0.8);
    drawRow(t.total, 'B');
  }
  if (t.note) {
    if (y + 2 * ROW_H > bottom()) {
      doc.addPage();
      y = MARGIN;
    }
    doc
      .font('R')
      .fontSize(9)
      .text(t.note, MARGIN, y + 8, { width: usable });
  }

  const stamp = new Intl.DateTimeFormat('bg-BG', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Sofia',
  }).format(generatedAt);
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const fy = doc.page.height - MARGIN - 8;
    doc.page.margins.bottom = 0; // writing in the margin must not add a page
    doc
      .font('R')
      .fontSize(7)
      .text(`Изготвено на ${stamp}`, MARGIN, fy, { width: usable / 2, lineBreak: false })
      .text(`стр. ${i + 1} от ${range.count}`, MARGIN + usable / 2, fy, {
        width: usable / 2,
        align: 'right',
        lineBreak: false,
      });
  }
  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}
