/** Period display helpers, shared by server and client components. */
const MONTHS = [
  'януари',
  'февруари',
  'март',
  'април',
  'май',
  'юни',
  'юли',
  'август',
  'септември',
  'октомври',
  'ноември',
  'декември',
];

export function periodLabel(p: { year: number; month: number }): string {
  return `${MONTHS[p.month - 1] ?? p.month} ${p.year}`;
}
