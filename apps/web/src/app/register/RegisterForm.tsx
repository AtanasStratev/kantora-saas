'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, ErrorText, Field } from '@/components/ui';
import { authClient, authErrorMessage } from '@/lib/auth-client';
import { registerOffice } from '../actions';

export function RegisterForm({ invite, email }: { invite?: string; email?: string }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const form = new FormData(e.currentTarget);
    const password = String(form.get('password'));
    if (password !== String(form.get('password2'))) {
      setError('Двете пароли не съвпадат.');
      return;
    }
    setBusy(true);
    const { error } = await authClient.signUp.email({
      name: String(form.get('name')),
      email: String(form.get('email')),
      password,
    });
    if (error) {
      setBusy(false);
      setError(authErrorMessage(error));
      return;
    }
    if (invite) {
      setBusy(false);
      router.push(`/2fa/setup?next=${encodeURIComponent(`/invite/${invite}`)}`);
      return;
    }
    const result = await registerOffice(String(form.get('office')));
    setBusy(false);
    if (result.error) {
      // The account exists; the home page offers to create the office again.
      setError(result.error);
      return;
    }
    router.push('/2fa/setup');
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <ErrorText>{error}</ErrorText>
      {invite ? null : (
        <Field
          label="Име на кантората"
          id="office"
          required
          autoFocus
          autoComplete="organization"
        />
      )}
      <Field
        label="Вашето име"
        id="name"
        required
        autoComplete="name"
        autoFocus={Boolean(invite)}
      />
      <Field
        label="Имейл"
        id="email"
        type="email"
        required
        autoComplete="username"
        {...(email ? { defaultValue: email, readOnly: true } : {})}
      />
      <Field
        label="Парола"
        id="password"
        type="password"
        required
        minLength={12}
        autoComplete="new-password"
        hint="Поне 12 символа. Най-сигурна е дълга фраза от няколко думи."
      />
      <Field
        label="Повторете паролата"
        id="password2"
        type="password"
        required
        autoComplete="new-password"
      />
      <Button type="submit" disabled={busy}>
        {busy ? 'Създаване…' : invite ? 'Създай профил' : 'Създай кантора'}
      </Button>
      <p className="mt-4 text-center text-xs text-fg-muted">
        Имате профил?{' '}
        <Link href="/login" className="text-accent underline">
          Вход
        </Link>
      </p>
    </form>
  );
}
