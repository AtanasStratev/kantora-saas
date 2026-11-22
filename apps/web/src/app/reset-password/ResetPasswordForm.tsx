'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button, ErrorText, Field } from '@/components/ui';
import { authClient, authErrorMessage } from '@/lib/auth-client';

export function ResetPasswordForm({ token }: { token: string }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const form = new FormData(e.currentTarget);
    const newPassword = String(form.get('password'));
    if (newPassword !== String(form.get('password2'))) {
      setError('Двете пароли не съвпадат.');
      return;
    }
    setBusy(true);
    const { error } = await authClient.resetPassword({ newPassword, token });
    setBusy(false);
    if (error) {
      setError(authErrorMessage(error));
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <div role="status" className="text-sm">
        <p className="mb-3">
          Паролата е сменена. Излязохте от всички устройства. Влезте с новата парола и кода от
          приложението.
        </p>
        <Link href="/login" className="text-accent underline">
          Към входа
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <ErrorText>{error}</ErrorText>
      <Field
        label="Нова парола"
        id="password"
        type="password"
        autoComplete="new-password"
        required
        autoFocus
        hint="Поне 12 символа."
      />
      <Field
        label="Повторете паролата"
        id="password2"
        type="password"
        autoComplete="new-password"
        required
      />
      <Button type="submit" disabled={busy}>
        {busy ? 'Запис…' : 'Смени паролата'}
      </Button>
    </form>
  );
}
