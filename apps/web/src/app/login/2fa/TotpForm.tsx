'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, ErrorText, Field } from '@/components/ui';
import { authClient, authErrorMessage } from '@/lib/auth-client';

export function TotpForm({ next }: { next: string }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [useBackup, setUseBackup] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const code = String(new FormData(e.currentTarget).get('code')).replace(/\s/g, '');
    const { error } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code })
      : await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (error) {
      setError(authErrorMessage(error));
      return;
    }
    router.push(next);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <ErrorText>{error}</ErrorText>
      <Field
        label={useBackup ? 'Резервен код' : 'Код от приложението'}
        id="code"
        inputMode={useBackup ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        required
        autoFocus
      />
      <Button type="submit" disabled={busy}>
        {busy ? 'Проверка…' : 'Потвърди'}
      </Button>
      <button
        type="button"
        className="mt-4 w-full text-center text-xs text-accent underline"
        onClick={() => setUseBackup((v) => !v)}
      >
        {useBackup ? 'Използвай код от приложението' : 'Нямам телефона: използвай резервен код'}
      </button>
    </form>
  );
}
