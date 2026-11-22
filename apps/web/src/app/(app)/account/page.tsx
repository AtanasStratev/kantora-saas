import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { requireSession } from '@/lib/session';
import { SessionList, type SessionRow } from './SessionList';

function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return 'Неизвестно устройство';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Браузър';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} на ${os}` : browser;
}

export default async function AccountPage() {
  const current = await requireSession();
  const sessions = await auth.api.listSessions({ headers: await headers() });
  const rows: SessionRow[] = sessions
    .map((s) => ({
      token: s.token,
      device: deviceLabel(s.userAgent),
      ip: s.ipAddress ?? '—',
      createdAt: new Date(s.createdAt).toISOString(),
      current: s.id === current.session.id,
    }))
    .sort(
      (a, b) => Number(b.current) - Number(a.current) || b.createdAt.localeCompare(a.createdAt),
    );

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold">Профил</h1>
      <p className="mb-6 text-sm text-fg-muted">
        {current.user.name} · {current.user.email} · двуфакторна защита: включена
      </p>
      <h2 className="mb-2 font-semibold">Активни сесии</h2>
      <p className="mb-3 text-sm text-fg-muted">
        Ако не познавате някое устройство, прекратете сесията му и сменете паролата.
      </p>
      <SessionList sessions={rows} />
    </div>
  );
}
