import { formatDate } from '@kantora/domain';
import { withTenant } from '@kantora/db';
import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { appPool } from '@/lib/db';

/** Human names for parameter keys; unknown keys are shown as-is. */
const LABEL: Record<string, string> = {
  eur_bgn_conversion_rate: 'Фиксиран курс лев/евро (лева за 1 евро)',
};

type Row = {
  key: string;
  value_numeric: string | null;
  value_json: unknown;
  valid_from: string;
  valid_to: string | null;
  source_url: string;
  source_ref: string;
  verified_at: string;
};

export default async function ParametersPage() {
  const ctx = await getAppContext();
  if (!ctx.office) return null;
  const rows = await withTenant(
    appPool,
    { userId: ctx.user.id, officeId: ctx.office.id },
    async (c) => {
      const r = await c.query<Row>(
        `SELECT key, value_numeric::text, value_json, to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
              to_char(valid_to, 'YYYY-MM-DD') AS valid_to, source_url, source_ref,
              to_char(verified_at, 'YYYY-MM-DD') AS verified_at
       FROM app.legal_parameter ORDER BY key, valid_from DESC`,
      );
      return r.rows;
    },
  );

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Параметри по закон</h1>
      <p className="mb-4 max-w-3xl text-sm text-fg-muted">
        Ставки, прагове и курсове с дата на действие и официален източник. Системата не пресмята
        нищо със стойност без източник. Промени се правят само от поддръжката след проверка в
        официалния текст.
      </p>
      {rows.length === 0 ? (
        <EmptyState
          title="Още няма въведени параметри"
          next="Те се добавят заедно с модулите, които ги ползват."
        />
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
              <th className="px-2 py-1 font-normal">Параметър</th>
              <th className="px-2 py-1 text-right font-normal">Стойност</th>
              <th className="px-2 py-1 font-normal">Валиден</th>
              <th className="px-2 py-1 font-normal">Източник</th>
              <th className="px-2 py-1 font-normal">Проверен</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.key}-${r.valid_from}`} className="border-b border-line align-top">
                <td className="px-2 py-1">
                  {LABEL[r.key] ?? r.key}
                  <div className="text-xs text-fg-muted">{r.key}</div>
                </td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {r.value_numeric !== null
                    ? r.value_numeric.replace(/0+$/, '').replace(/\.$/, '').replace('.', ',')
                    : JSON.stringify(r.value_json)}
                </td>
                <td className="px-2 py-1 whitespace-nowrap">
                  от {formatDate(r.valid_from)}
                  {r.valid_to ? ` до ${formatDate(r.valid_to)}` : ''}
                </td>
                <td className="px-2 py-1">
                  <a
                    href={r.source_url}
                    className="text-accent underline"
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    {r.source_ref}
                  </a>
                </td>
                <td className="px-2 py-1 whitespace-nowrap">{formatDate(r.verified_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
