import { can, isRole } from '@kantora/domain';
import { withTenant } from '@kantora/db';
import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { appPool } from '@/lib/db';
import { ImportForm } from './ImportForm';

/** Внос от Excel по шаблона на програмата (ADR-0017). */
export default async function ImportPage() {
  const ctx = await getAppContext();
  const role = ctx.office?.role;
  if (!ctx.office || !ctx.company) {
    return <EmptyState title="Изберете фирма" next="Смяна на фирма:" shortcut="Ctrl+Shift+K" />;
  }
  if (!isRole(role) || !can(role, 'company.edit')) {
    return (
      <EmptyState
        title="Вносът е за собственика и главния счетоводител"
        next="Обърнете се към тях."
      />
    );
  }
  const tenant = { userId: ctx.user.id, officeId: ctx.office.id, companyId: ctx.company.id };
  const { years, runs } = await withTenant(appPool, tenant, async (c) => ({
    years: (
      await c.query<{ year: number }>('SELECT year FROM app.fiscal_year ORDER BY year')
    ).rows.map((r) => r.year),
    runs: (
      await c.query<{
        id: string;
        file_name: string;
        created_at: Date;
        entries: number;
        opening: boolean;
      }>(
        `SELECT r.id, r.file_name, r.created_at,
                (SELECT count(*)::int FROM app.journal_entry e WHERE e.import_run_id = r.id
                   AND NOT EXISTS (SELECT 1 FROM app.journal_line l WHERE l.entry_id = e.id AND l.is_opening)) AS entries,
                EXISTS (SELECT 1 FROM app.journal_entry e JOIN app.journal_line l ON l.entry_id = e.id
                         WHERE e.import_run_id = r.id AND l.is_opening) AS opening
         FROM app.import_run r ORDER BY r.created_at DESC LIMIT 20`,
      )
    ).rows,
  }));

  return (
    <div className="max-w-5xl">
      <h1 className="mb-1 text-xl font-semibold">Внос от Excel — {ctx.company.name}</h1>
      <p className="mb-3 max-w-3xl text-sm text-fg-muted">
        Сметки, контрагенти, обекти, начални салда и статии по шаблона на програмата. Първо
        „Провери“: програмата показва какво ще внесе и всички грешки с лист и ред, без да записва
        нищо. После „Внеси“: записва се всичко или нищо, със същите проверки като при ръчното
        въвеждане.
      </p>
      <p className="mb-4 text-sm">
        <a className="text-accent underline" href="/import-template" download>
          Изтегли празния шаблон (.xlsx)
        </a>
      </p>
      <ImportForm
        years={years}
        defaultYear={ctx.period?.year ?? years.at(-1) ?? new Date().getFullYear()}
      />
      {runs.length ? (
        <section className="mt-6">
          <h2 className="mb-1 font-semibold">Предишни вноски</h2>
          <ul className="text-sm">
            {runs.map((r) => (
              <li key={r.id}>
                {[
                  r.created_at.toLocaleString('bg-BG', { timeZone: 'Europe/Sofia' }),
                  r.file_name,
                  r.opening ? 'начални салда' : null,
                  `${r.entries} статии`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
