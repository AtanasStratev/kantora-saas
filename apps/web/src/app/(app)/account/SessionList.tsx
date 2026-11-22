'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button, ErrorText } from '@/components/ui';
import { authClient, authErrorMessage } from '@/lib/auth-client';

export type SessionRow = {
  token: string;
  device: string;
  ip: string;
  createdAt: string;
  current: boolean;
};

const fmt = new Intl.DateTimeFormat('bg-BG', { dateStyle: 'short', timeStyle: 'short' });

export function SessionList({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter();
  const [error, setError] = useState('');

  async function run(
    p: Promise<{
      error: { status?: number | undefined; code?: string | undefined } | null;
    }>,
  ) {
    setError('');
    const { error } = await p;
    if (error) setError(authErrorMessage(error));
    router.refresh();
  }

  const others = sessions.filter((s) => !s.current).length;
  return (
    <div>
      <ErrorText>{error}</ErrorText>
      <table className="mb-4 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
            <th className="px-2 py-1 font-normal">Устройство</th>
            <th className="px-2 py-1 font-normal">IP адрес</th>
            <th className="px-2 py-1 font-normal">Влизане</th>
            <th className="px-2 py-1 font-normal">
              <span className="sr-only">Действие</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.token} className="border-b border-line">
              <td className="px-2 py-1">
                {s.device}
                {s.current ? (
                  <span className="ml-2 text-xs text-positive">това устройство</span>
                ) : null}
              </td>
              <td className="px-2 py-1 tabular-nums">{s.ip}</td>
              <td className="px-2 py-1 tabular-nums">{fmt.format(new Date(s.createdAt))}</td>
              <td className="px-2 py-1 text-right">
                {s.current ? null : (
                  <Button
                    inline
                    variant="ghost"
                    onClick={() => run(authClient.revokeSession({ token: s.token }))}
                  >
                    Прекрати
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {others > 0 ? (
        <ConfirmDialog
          trigger={
            <Button inline variant="danger">
              Излез от всички други устройства ({others})…
            </Button>
          }
          title="Изход от другите устройства"
          description="Всички други сесии се прекратяват веднага. Тази остава активна."
          confirmLabel="Прекрати всички"
          onConfirm={() => run(authClient.revokeOtherSessions())}
        />
      ) : (
        <p className="text-sm text-fg-muted">Няма други активни сесии.</p>
      )}
    </div>
  );
}
