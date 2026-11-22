'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button, ErrorText, Field } from '@/components/ui';
import { authClient, authErrorMessage } from '@/lib/auth-client';

export function ForgotPasswordForm() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error } = await authClient.requestPasswordReset({
      email: String(new FormData(e.currentTarget).get('email')),
      redirectTo: '/reset-password',
    });
    setBusy(false);
    // Same answer whether or not the account exists, so the form cannot reveal who has one.
    if (error && error.status === 429) {
      setError(authErrorMessage(error));
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <div role="status" className="text-sm">
        <p className="mb-3">
          Ако има профил с този имейл, изпратихме връзка за смяна на паролата (валидна 1 час).
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
      <p className="mb-3 text-sm text-fg-muted">
        Въведете имейла си. Ще получите връзка за нова парола. Двуфакторната защита остава.
      </p>
      <Field label="Имейл" id="email" type="email" autoComplete="username" required autoFocus />
      <Button type="submit" disabled={busy}>
        {busy ? 'Изпращане…' : 'Изпрати връзка'}
      </Button>
    </form>
  );
}
