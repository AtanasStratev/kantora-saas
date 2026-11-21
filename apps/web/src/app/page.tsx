import { withUser } from '@kantora/db';
import { Card } from '@/components/ui';
import { appPool } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { CreateOfficeForm } from './CreateOfficeForm';
import { SignOutButton } from './SignOutButton';

type OfficeRow = { office_id: string; office_name: string; role: string };

const ROLE_LABEL: Record<string, string> = {
  owner: 'собственик',
  chief_accountant: 'главен счетоводител',
  accountant: 'оперативен счетоводител',
  payroll: 'ТРЗ',
  read_only: 'само четене',
};

export default async function HomePage() {
  const session = await requireSession();
  const offices = await withUser(appPool, session.user.id, async (c) => {
    const r = await c.query<OfficeRow>('SELECT * FROM app.my_offices()');
    return r.rows;
  });

  return (
    <Card title={`Здравейте, ${session.user.name}`}>
      {offices.length === 0 ? (
        <>
          <p className="mb-4 text-sm text-fg-muted">
            Още не сте член на кантора. Създайте своята, за да започнете.
          </p>
          <CreateOfficeForm />
        </>
      ) : (
        <ul className="mb-4 flex flex-col gap-2">
          {offices.map((o) => (
            <li key={o.office_id} className="rounded border border-line px-3 py-2">
              <div className="font-medium">{o.office_name}</div>
              <div className="text-xs text-fg-muted">{ROLE_LABEL[o.role] ?? o.role}</div>
            </li>
          ))}
        </ul>
      )}
      <SignOutButton />
    </Card>
  );
}
