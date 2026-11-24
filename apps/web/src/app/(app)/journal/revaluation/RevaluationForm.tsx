'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, ErrorText, Kbd, inputClass } from '@/components/ui';
import { runRevaluation } from '../../fx-actions';

/**
 * Picks the accounts for the differences (the chart is data: no account numbers in the
 * code) and posts. Ctrl+Enter posts from anywhere in the form.
 */
export function RevaluationForm({
  periodId,
  accounts,
  defaultGain,
  defaultLoss,
}: {
  periodId: string;
  accounts: { id: string; label: string }[];
  defaultGain: string;
  defaultLoss: string;
}) {
  const router = useRouter();
  const [gain, setGain] = useState(defaultGain);
  const [loss, setLoss] = useState(defaultLoss);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ id: string; number: number } | null>(null);

  async function submit() {
    setError('');
    if (!gain || !loss) {
      setError('Изберете сметки за положителните и отрицателните разлики.');
      return;
    }
    setBusy(true);
    const r = await runRevaluation({ periodId, gainAccountId: gain, lossAccountId: loss });
    setBusy(false);
    if (r.error !== undefined) {
      setError(r.error);
      return;
    }
    setDone({ id: r.entryId, number: r.number });
    router.refresh();
  }

  const select = (id: string, label: string, value: string, set: (v: string) => void) => (
    <label htmlFor={id} className="flex flex-col gap-1 text-xs text-fg-muted">
      {label}
      <select
        id={id}
        className={`${inputClass} min-w-72`}
        value={value}
        onChange={(e) => set(e.target.value)}
      >
        <option value="">— изберете сметка —</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <form
      className="rounded border border-line bg-surface-raised p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === 'Enter') {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <h2 className="mb-3 font-semibold">Осчетоводяване</h2>
      <div className="mb-3 flex flex-wrap gap-4">
        {select(
          'fx-gain-account',
          'Сметка за положителните разлики (финансов приход)',
          gain,
          setGain,
        )}
        {select(
          'fx-loss-account',
          'Сметка за отрицателните разлики (финансов разход)',
          loss,
          setLoss,
        )}
      </div>
      <ErrorText>{error}</ErrorText>
      {done ? (
        <p role="status" className="mb-2 text-sm text-positive">
          Преоценката е осчетоводена:{' '}
          <Link className="text-accent underline" href={`/journal/${done.id}`}>
            статия № {done.number}
          </Link>
          .
        </p>
      ) : null}
      <Button inline type="submit" disabled={busy}>
        {busy ? 'Осчетоводяване…' : 'Осчетоводи преоценката'} <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd>
      </Button>
      <p className="mt-2 text-xs text-fg-muted">
        Една статия към последния ден на периода. Корекция: сторно на статията (F8).
      </p>
    </form>
  );
}
