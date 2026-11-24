import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The three ranges every report offers: the selected month, from the start of the year,
 * the whole year. Plain links, so they are reachable with Tab and open with Enter.
 */
export function ReportRangeNav({
  month,
  monthLabel,
  year,
  keep,
  children,
}: {
  month: number;
  monthLabel: string;
  year: number;
  /** Other query parameters of the page to keep (account, grouping). */
  keep?: Record<string, string>;
  /** Export links, shown on the right. */
  children?: ReactNode;
}) {
  const q = (f: number, t: number) =>
    `?${new URLSearchParams({ ...keep, from: String(f), to: String(t) }).toString()}`;
  const cls = 'rounded border border-line px-2 py-0.5';
  return (
    <nav aria-label="Период на справката" className="mb-4 flex flex-wrap gap-2 text-sm">
      <Link className={cls} href={q(month, month)}>
        {monthLabel}
      </Link>
      <Link className={cls} href={q(1, month)}>
        От началото на годината
      </Link>
      <Link className={cls} href={q(1, 12)}>
        Цялата {year}
      </Link>
      {children ? <span className="ml-auto">{children}</span> : null}
    </nav>
  );
}

/** Rows shown on screen before the report says "the rest is in the file". */
export const SCREEN_ROW_LIMIT = 2000;
