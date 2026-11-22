'use client';
import { formatDate, ROLE_LABEL, ROLES, type Role } from '@kantora/domain';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Checkbox } from '@/components/Checkbox';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Select } from '@/components/Select';
import { Badge, Button, ErrorText, Field } from '@/components/ui';
import {
  changeRole,
  createInvitation,
  removeMember,
  revokeInvitation,
  setCompanyAccess,
} from './actions';

export type MemberRow = {
  userId: string;
  name: string;
  email: string;
  role: Role;
  companyIds: string[];
  isSelf: boolean;
};
export type InvitationRow = {
  id: string;
  email: string;
  role: Role;
  expired: boolean;
  expiresAt: string;
};

const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }));

export function TeamManager({
  officeName,
  members,
  invitations,
  companies,
}: {
  officeName: string;
  members: MemberRow[];
  invitations: InvitationRow[];
  companies: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [error, setError] = useState('');

  async function run(action: () => Promise<{ error?: string }>) {
    setError('');
    const r = await action();
    if (r.error) setError(r.error);
    router.refresh();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <section>
        <h1 className="mb-4 text-xl font-semibold">Екип на {officeName}</h1>
        <ErrorText>{error}</ErrorText>
        <ul className="flex flex-col gap-3">
          {members.map((m) => (
            <li key={m.userId} className="rounded border border-line bg-surface-raised p-4">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <div className="font-medium">
                    {m.name}{' '}
                    {m.isSelf ? <span className="text-xs text-fg-muted">(вие)</span> : null}
                  </div>
                  <div className="text-xs text-fg-muted">{m.email}</div>
                </div>
                <div className="w-56">
                  <Select
                    label="Роля"
                    options={ROLE_OPTIONS}
                    value={m.role}
                    onValueChange={(v) => run(() => changeRole(m.userId, v as Role))}
                  />
                </div>
              </div>
              {m.role === 'owner' ? (
                <p className="text-xs text-fg-muted">Собственикът има достъп до всички фирми.</p>
              ) : companies.length === 0 ? (
                <p className="text-xs text-fg-muted">В кантората още няма фирми.</p>
              ) : (
                <fieldset>
                  <legend className="mb-2 text-xs text-fg-muted">Достъп до фирми</legend>
                  <div className="grid gap-x-4 sm:grid-cols-2">
                    {companies.map((c) => (
                      <Checkbox
                        key={`${m.userId}-${c.id}-${m.companyIds.includes(c.id)}`}
                        label={c.name}
                        defaultChecked={m.companyIds.includes(c.id)}
                        onCheckedChange={(checked) =>
                          run(() => setCompanyAccess(m.userId, c.id, checked))
                        }
                      />
                    ))}
                  </div>
                </fieldset>
              )}
              {!m.isSelf ? (
                <div className="mt-2">
                  <ConfirmDialog
                    trigger={
                      <Button inline variant="ghost">
                        Премахни от кантората…
                      </Button>
                    }
                    title={`Премахване на ${m.name}`}
                    description="Губи достъп до всички фирми на кантората веднага. Може да бъде поканен отново. Действията му остават в одитния журнал."
                    confirmLabel="Премахни"
                    onConfirm={() => run(() => removeMember(m.userId))}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <aside className="flex flex-col gap-6">
        <div className="rounded border border-line bg-surface-raised p-4">
          <h2 className="mb-3 font-semibold">Покани потребител</h2>
          <InviteForm onDone={() => router.refresh()} />
        </div>
        {invitations.length > 0 ? (
          <div className="rounded border border-line bg-surface-raised p-4">
            <h2 className="mb-3 font-semibold">Чакащи покани</h2>
            <ul className="flex flex-col gap-2 text-sm">
              {invitations.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-2">
                  <span>
                    {i.email}
                    <span className="block text-xs text-fg-muted">
                      {ROLE_LABEL[i.role]} ·{' '}
                      {i.expired ? 'изтекла' : `до ${formatDate(i.expiresAt)}`}
                    </span>
                  </span>
                  {i.expired ? <Badge kind="warning">Изтекла</Badge> : null}
                  <Button inline variant="ghost" onClick={() => run(() => revokeInvitation(i.id))}>
                    Отмени
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function InviteForm({ onDone }: { onDone: () => void }) {
  const [role, setRole] = useState<Role>('accountant');
  const [error, setError] = useState('');
  const [link, setLink] = useState('');
  const [mailed, setMailed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setLink('');
    const form = e.currentTarget;
    const r = await createInvitation({
      email: String(new FormData(form).get('invite-email')),
      role,
    });
    setBusy(false);
    if (r.error) {
      setError(r.error);
      return;
    }
    setLink(r.link ?? '');
    setMailed(r.mailed === true);
    form.reset();
    onDone();
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <ErrorText>{error}</ErrorText>
      <Field label="Имейл" id="invite-email" type="email" autoComplete="off" required />
      <Select
        label="Роля"
        options={ROLE_OPTIONS}
        value={role}
        onValueChange={(v) => setRole(v as Role)}
      />
      <Button type="submit" disabled={busy}>
        {busy ? 'Създаване…' : 'Създай покана'}
      </Button>
      {link ? (
        <div className="mt-4 rounded border border-positive p-2 text-xs">
          <p className="mb-1">
            {mailed
              ? 'Поканата е изпратена по имейл. Ако не стигне, изпратете тази връзка сами'
              : 'Имейлът не можа да се изпрати. Изпратете тази връзка на поканения сами'}{' '}
            (валидна 7 дни, за еднократна употреба). Показва се само сега.
          </p>
          <code className="block select-all break-all" data-testid="invite-link">
            {link}
          </code>
        </div>
      ) : null}
    </form>
  );
}
