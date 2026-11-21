'use client';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { Button, ErrorText, Field } from '@/components/ui';
import { createCompany } from '../context-actions';

export function NewCompanyForm() {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(e.currentTarget);
    const result = await createCompany({
      name: String(data.get('company-name')),
      eik: String(data.get('company-eik')),
    });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    form.current?.reset();
    router.refresh();
  }

  return (
    <form ref={form} onSubmit={onSubmit} noValidate>
      <ErrorText>{error}</ErrorText>
      <Field label="Наименование" id="company-name" required autoComplete="off" />
      <Field
        label="ЕИК (по желание)"
        id="company-eik"
        inputMode="numeric"
        autoComplete="off"
        hint="9 или 13 цифри. Контролната сума се проверява във Фаза 2."
      />
      <Button type="submit" disabled={busy}>
        {busy ? 'Създаване…' : 'Създай фирма'}
      </Button>
      <p className="mt-2 text-xs text-fg-muted">
        Създава се и текущата година с 12 месечни периода.
      </p>
    </form>
  );
}
