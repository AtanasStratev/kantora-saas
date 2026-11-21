import { ROLE_LABEL, isRole } from '@kantora/domain';
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card } from '@/components/ui';
import { auth } from '@/lib/auth';
import { appPool } from '@/lib/db';
import { AcceptInvitation } from './AcceptInvitation';

const STATUS_TEXT: Record<string, string> = {
  accepted: 'Тази покана вече е използвана. Ако това сте вие, просто влезте.',
  expired: 'Поканата е изтекла. Помолете собственика на кантората за нова.',
  revoked: 'Поканата е отменена. Помолете собственика на кантората за нова.',
};

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await appPool.query<{
    office_name: string;
    email: string;
    role: string;
    status: string;
  }>('SELECT * FROM app.invitation_preview($1)', [token]);
  const inv = r.rows[0];
  if (!inv) {
    return (
      <Card title="Невалидна покана">
        <p className="text-sm text-fg-muted">
          Връзката не е разпозната. Проверете дали е копирана изцяло или помолете за нова.
        </p>
      </Card>
    );
  }
  if (inv.status !== 'open') {
    return (
      <Card title="Поканата не е активна">
        <p className="mb-4 text-sm text-fg-muted">{STATUS_TEXT[inv.status]}</p>
        <Link href="/login" className="text-accent underline">
          Към входа
        </Link>
      </Card>
    );
  }

  const here = `/invite/${encodeURIComponent(token)}`;
  const role = isRole(inv.role) ? ROLE_LABEL[inv.role] : inv.role;
  const session = await auth.api.getSession({ headers: await headers() });
  if (session && !session.user.twoFactorEnabled) {
    redirect(`/2fa/setup?next=${encodeURIComponent(here)}`);
  }

  return (
    <Card title={`Покана за ${inv.office_name}`}>
      <p className="mb-4 text-sm">
        Поканени сте като <strong>{role}</strong> с имейл <strong>{inv.email}</strong>.
      </p>
      {session ? (
        <AcceptInvitation token={token} signedInAs={session.user.email} invitedEmail={inv.email} />
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <Link
            className="rounded bg-accent px-3 py-1.5 text-center font-medium text-accent-fg"
            href={`/register?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(inv.email)}`}
          >
            Нямам профил: регистрация
          </Link>
          <Link
            className="rounded border border-line-strong px-3 py-1.5 text-center"
            href={`/login?next=${encodeURIComponent(here)}`}
          >
            Имам профил: вход
          </Link>
        </div>
      )}
    </Card>
  );
}
