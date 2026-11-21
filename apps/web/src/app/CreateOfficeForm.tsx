'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, ErrorText, Field } from '@/components/ui';
import { registerOffice } from './actions';

export function CreateOfficeForm() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const result = await registerOffice(String(new FormData(e.currentTarget).get('office')));
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mb-4">
      <ErrorText>{error}</ErrorText>
      <Field label="Име на кантората" id="office" required autoFocus />
      <Button type="submit" disabled={busy}>
        Създай кантора
      </Button>
    </form>
  );
}
