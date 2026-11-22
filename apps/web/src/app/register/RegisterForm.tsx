'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button, ErrorText, Field } from '@/components/ui';
import { authClient, authErrorMessage } from '@/lib/auth-client';

export function RegisterForm({ invite, email }: { invite?: string; email?: string }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const form = new FormData(e.currentTarget);
    const password = String(form.get('password'));
    const office = String(form.get('office') ?? '').trim();
    if (!invite && office.length < 2) {
      setError('Въведете име на кантората.');
      return;
    }
    if (password !== String(form.get('password2'))) {
      setError('Двете пароли не съвпадат.');
      return;
    }
    // After the e-mail link: mandatory 2FA, then the invitation or office creation.
    const next = invite ? `/invite/${invite}` : `/?office=${encodeURIComponent(office)}`;
    setBusy(true);
    const address = String(form.get('email'));
    const { error } = await authClient.signUp.email({
      name: String(form.get('name')),
      email: address,
      password,
      callbackURL: `/2fa/setup?next=${encodeURIComponent(next)}`,
    });
    setBusy(false);
    if (error) {
      setError(authErrorMessage(error));
      return;
    }
    setSentTo(address);
  }

  if (sentTo) {
    return (
      <div role="status">
        <p className="mb-3 text-sm">
          Изпратихме връзка за потвърждение на <strong>{sentTo}</strong>.
        </p>
        <p className="mb-4 text-sm text-fg-muted">
          Отворете я, за да продължите (валидна 24 часа). Ако не виждате имейла, проверете папката
          за спам или опитайте да влезете: ще изпратим нова връзка.
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
