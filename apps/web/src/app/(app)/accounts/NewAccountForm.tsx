'use client';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { Checkbox } from '@/components/Checkbox';
import { Button, ErrorText, Field } from '@/components/ui';
import { createAccount } from '../ledger-actions';

export function NewAccountForm() {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [isGroup, setIsGroup] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(e.currentTarget);
    const r = await createAccount({
      code: String(data.get('account-code')),
      name: String(data.get('account-name')),
      isPostable: !isGroup,
    });
    setBusy(false);
    if (r.error) {
      setError(r.error);
      return;
    }
    form.current?.reset();
    form.current?.querySelector<HTMLInputElement>('#account-code')?.focus();
    router.refresh();
  }

  return (
    <form ref={form} onSubmit={onSubmit} noValidate>
      <ErrorText>{error}</ErrorText>
      <Field label="Код" id="account-code" required autoComplete="off" autoFocus />
      <Field label="Наименование" id="account-name" required autoComplete="off" />
      <Checkbox label="Групова (не се осчетоводява по нея)" onCheckedChange={setIsGroup} />
      <Button type="submit" disabled={busy}>
        {busy ? 'Запис…' : 'Добави сметка'}
      </Button>
      <p className="mt-2 text-xs text-fg-muted">
        След запис курсорът се връща на „Код“ за следващата.
      </p>
    </form>
  );
}
