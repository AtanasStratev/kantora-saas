/**
 * "Excel" and "PDF" of the report on screen. Plain links (reachable with Tab, open with
 * Enter); the browser downloads the file the server builds from the same query.
 */
export function ExportLinks({
  report,
  params,
}: {
  report: 'trial-balance' | 'account-card' | 'journal' | 'general-ledger' | 'register';
  params: Record<string, string | number>;
}) {
  const href = (format: 'xlsx' | 'pdf') =>
    `/export/${report}?${new URLSearchParams({
      format,
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    }).toString()}`;
  const cls = 'rounded border border-line px-2 py-0.5 text-sm';
  return (
    <span className="flex items-center gap-2" aria-label="Износ">
      <a className={cls} href={href('xlsx')} download>
        Excel
      </a>
      <a className={cls} href={href('pdf')} download>
        PDF
      </a>
    </span>
  );
}
