'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, ErrorText, Field } from '@/components/ui';
import { authClient, authErrorMessage } from '@/lib/auth-client';

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(e.currentTarget);
    const { data, error } = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
    });
    setBusy(false);
    if (error) {
      setError(authErrorMessage(error));
      return;
    }
    if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) {
      router.push('/login/2fa');
      return;
    }
    router.push('/');
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <ErrorText>{error}</ErrorText>
      <Field label="Имейл" id="email" type="email" autoComplete="username" required autoFocus />
      <Field
        label="Парола"
        id="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <Button type="submit" disabled={busy}>
        {busy ? 'Влизане…' : 'Вход'}
      </Button>
      <p className="mt-4 text-center text-xs text-fg-muted">
        Нямате профил?{' '}
        <Link href="/register" className="text-accent underline">
          Регистрирайте кантора
        </Link>
      </p>
    </form>
  );
}
