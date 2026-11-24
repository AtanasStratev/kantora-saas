'use client';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { Checkbox } from '@/components/Checkbox';
import { Button, ErrorText, Field } from '@/components/ui';
import {
  createCostObject,
  createCounterparty,
  setAccountNeed,
  setCostObjectActive,
  setCounterpartyActive,
} from '../analytics-actions';

export function NewCounterpartyForm() {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const d = new FormData(e.currentTarget);
    const r = await createCounterparty({
      name: String(d.get('cp-name')),
      eik: String(d.get('cp-eik')),
      vatNumber: String(d.get('cp-vat')),
      address: String(d.get('cp-address')),
    });
    setBusy(false);
    if (r.error !== undefined) {
      setError(r.error);
      return;
    }
    form.current?.reset();
    form.current?.querySelector<HTMLInputElement>('#cp-name')?.focus();
    router.refresh();
  }

  return (
    <form ref={form} onSubmit={onSubmit} noValidate>
      <ErrorText>{error}</ErrorText>
      <Field label="Наименование" id="cp-name" required autoComplete="off" autoFocus />
      <Field
        label="ЕИК"
        id="cp-eik"
        inputMode="numeric"
        autoComplete="off"
        hint="9 цифри (13 за клон). Контролната цифра още не се проверява."
      />
      <Field label="ДДС номер" id="cp-vat" autoComplete="off" hint="Напр. BG и цифрите" />
      <Field label="Адрес" id="cp-address" autoComplete="off" />
      <Button type="submit" disabled={busy}>
        {busy ? 'Запис…' : 'Добави контрагент'}
      </Button>
    </form>
  );
}

export function NewCostObjectForm() {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const d = new FormData(e.currentTarget);
    const r = await createCostObject({
      code: String(d.get('obj-code')),
      name: String(d.get('obj-name')),
    });
    setBusy(false);
    if (r.error !== undefined) {
      setError(r.error);
      return;
    }
    form.current?.reset();
    form.current?.querySelector<HTMLInputElement>('#obj-code')?.focus();
    router.refresh();
  }

  return (
    <form ref={form} onSubmit={onSubmit} noValidate>
      <ErrorText>{error}</ErrorText>
      <Field label="Код" id="obj-code" required autoComplete="off" autoFocus />
      <Field label="Наименование" id="obj-name" required autoComplete="off" />
      <Button type="submit" disabled={busy}>
        {busy ? 'Запис…' : 'Добави обект'}
      </Button>
    </form>
  );
}

/** A checkbox that saves on change (Space toggles it); errors are shown next to it. */
function SavingCheckbox({
  label,
  checked,
  save,
}: {
  label: string;
  checked: boolean;
  save: (value: boolean) => Promise<{ error?: string | undefined }>;
}) {
  const router = useRouter();
  const [error, setError] = useState('');
  return (
    <span className="inline-flex items-center gap-2 [&>div]:mb-0">
      <Checkbox
        label={label}
        defaultChecked={checked}
        onCheckedChange={(v) => {
          setError('');
          void save(v).then((r) => {
            if (r.error) setError(r.error);
            else router.refresh();
          });
        }}
      />
      {error ? (
        <span role="alert" className="text-xs text-negative">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function CounterpartyActive({ id, active }: { id: string; active: boolean }) {
  return (
    <SavingCheckbox label="активен" checked={active} save={(v) => setCounterpartyActive(id, v)} />
  );
}

export function CostObjectActive({ id, active }: { id: string; active: boolean }) {
  return (
    <SavingCheckbox label="активен" checked={active} save={(v) => setCostObjectActive(id, v)} />
  );
}

export function AccountNeed({
  accountId,
  need,
  label,
  checked,
}: {
  accountId: string;
  need: 'counterparty' | 'document' | 'cost_object' | 'currency';
  label: string;
  checked: boolean;
}) {
  return (
    <SavingCheckbox
      label={label}
      checked={checked}
      save={(value) => setAccountNeed({ accountId, need, value })}
    />
  );
}
