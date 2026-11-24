'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, ErrorText, Kbd, inputClass } from '@/components/ui';
import { addPreviousYear, convertToEuro, setConversionClass } from '../../euro-actions';

export function AddYearButton({ year }: { year: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div>
      <ErrorText>{error}</ErrorText>
      <Button
        inline
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void addPreviousYear(year).then((r) => {
            setBusy(false);
            if (r.error !== undefined) setError(r.error);
            else router.refresh();
          });
        }}
      >
        {busy ? 'Добавяне…' : `Добави ${year} г. (в лева)`}
      </Button>
    </div>
  );
}

const CLASSES = [
  ['standard', 'обикновено (чл. 12–13)'],
  ['equity', 'собствен капитал (чл. 48, ал. 6)'],
  ['wages', 'възнаграждения (чл. 45)'],
] as const;

/** Saves on change; the page re-reads and recomputes the preview. */
export function ConversionClassSelect({
  accountId,
  code,
  value,
}: {
  accountId: string;
  code: string;
  value: string;
}) {
  const router = useRouter();
  const [error, setError] = useState('');
  return (
    <span className="inline-flex items-center gap-2">
      <select
        aria-label={`Превалутиране на сметка ${code}`}
        className={`${inputClass} py-0.5 text-xs`}
        defaultValue={value}
        onChange={(e) => {
          setError('');
          void setConversionClass(accountId, e.target.value as (typeof CLASSES)[number][0]).then(
            (r) => (r.error !== undefined ? setError(r.error) : router.refresh()),
          );
        }}
      >
        {CLASSES.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      {error ? (
        <span role="alert" className="text-xs text-negative">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function ConvertForm({
  accounts,
  defaults,
  disabled,
}: {
  accounts: { id: string; label: string }[];
  defaults: { gain: string; loss: string; equity: string };
  disabled: boolean;
}) {
  const router = useRouter();
  const [v, setV] = useState(defaults);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ id: string; number: number } | null>(null);

  async function submit() {
    setError('');
    if (!v.gain || !v.loss || !v.equity) {
      setError('Изберете трите сметки за разликите.');
      return;
    }
    setBusy(true);
    const r = await convertToEuro({
      gainAccountId: v.gain,
      lossAccountId: v.loss,
      equityAccountId: v.equity,
    });
    setBusy(false);
    if (r.error !== undefined) {
      setError(r.error);
      return;
    }
    setDone({ id: r.entryId, number: r.number });
    router.refresh();
  }

  const select = (key: 'gain' | 'loss' | 'equity', id: string, label: string) => (
    <label htmlFor={id} className="flex flex-col gap-1 text-xs text-fg-muted">
      {label}
      <select
        id={id}
        className={`${inputClass} min-w-72`}
        value={v[key]}
        onChange={(e) => setV((x) => ({ ...x, [key]: e.target.value }))}
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
        {select('gain', 'euro-gain', 'Положителни разлики (текущ приход, чл. 48, ал. 4)')}
        {select('loss', 'euro-loss', 'Отрицателни разлики (текущ разход, чл. 48, ал. 4)')}
        {select('equity', 'euro-equity', 'Разлики на собствения капитал (чл. 48, ал. 6)')}
      </div>
      <ErrorText>{error}</ErrorText>
      {done ? (
        <p role="status" className="mb-2 text-sm text-positive">
          Салдата са превалутирани:{' '}
          <Link className="text-accent underline" href={`/journal/${done.id}`}>
            статия № {done.number}
          </Link>
          .
        </p>
      ) : null}
      <Button inline type="submit" disabled={busy || disabled}>
        {busy ? 'Превалутиране…' : 'Превалутирай салдата'} <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd>
      </Button>
      <p className="mt-2 text-xs text-fg-muted">
        Една статия с начални салда към първия ден на годината в евро. Корекция: сторно на статията
        (F8) и ново превалутиране.
      </p>
    </form>
  );
}
