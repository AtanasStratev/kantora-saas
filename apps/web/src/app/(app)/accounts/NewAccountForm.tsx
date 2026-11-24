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
  const [needs, setNeeds] = useState({ counterparty: false, document: false, costObject: false });
  const [isCurrency, setIsCurrency] = useState(false);
  const [formKey, setFormKey] = useState(0);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(e.currentTarget);
    const r = await createAccount({
      code: String(data.get('account-code')),
      name: String(data.get('account-name')),
      isPostable: !isGroup,
      needs: isGroup ? { counterparty: false, document: false, costObject: false } : needs,
      isCurrency: !isGroup && isCurrency,
    });
    setBusy(false);
    if (r.error) {
      setError(r.error);
      return;
    }
    form.current?.reset();
    // Checkboxes are uncontrolled: a new key resets them with the form.
    setIsGroup(false);
    setIsCurrency(false);
    setNeeds({ counterparty: false, document: false, costObject: false });
    setFormKey((k) => k + 1);
    form.current?.querySelector<HTMLInputElement>('#account-code')?.focus();
    router.refresh();
  }

  return (
    <form ref={form} onSubmit={onSubmit} noValidate>
      <ErrorText>{error}</ErrorText>
      <Field label="Код" id="account-code" required autoComplete="off" autoFocus />
      <Field label="Наименование" id="account-name" required autoComplete="off" />
      <div key={formKey}>
        <Checkbox label="Групова (не се осчетоводява по нея)" onCheckedChange={setIsGroup} />
        {isGroup ? null : (
          <fieldset className="mb-3">
            <legend className="mb-1 text-xs text-fg-muted">Аналитичност и валута</legend>
            <Checkbox
              label="Контрагент"
              onCheckedChange={(v) => setNeeds((n) => ({ ...n, counterparty: v }))}
            />
            <Checkbox
              label="Документ"
              onCheckedChange={(v) => setNeeds((n) => ({ ...n, document: v }))}
            />
            <Checkbox
              label="Обект"
              onCheckedChange={(v) => setNeeds((n) => ({ ...n, costObject: v }))}
            />
            <Checkbox
              label="Валутна (парична позиция в чуждестранна валута)"
              onCheckedChange={setIsCurrency}
            />
          </fieldset>
        )}
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? 'Запис…' : 'Добави сметка'}
      </Button>
      <p className="mt-2 text-xs text-fg-muted">
        След запис курсорът се връща на „Код“ за следващата.
      </p>
    </form>
  );
}
