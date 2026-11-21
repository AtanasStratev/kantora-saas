'use client';
import { formatDate, parseQuickDate, type PeriodContext } from '@kantora/domain';
import { useId, useState } from 'react';
import { inputClass } from './ui';

/** Quick date entry: "15" = 15th of the current period, "1511", "15.11", "+1", "д". */
export function DateInput({
  label,
  period,
  onValue,
}: {
  label: string;
  period: PeriodContext;
  onValue?: (iso: string | null) => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  function commit() {
    if (text.trim() === '') {
      setError('');
      onValue?.(null);
      return;
    }
    const r = parseQuickDate(text, period);
    if (r.ok) {
      setError('');
      setText(formatDate(r.value));
      onValue?.(r.value);
    } else {
      setError(r.error);
      onValue?.(null);
    }
  }

  return (
    <div className="mb-3 flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        className={`${inputClass} tabular-nums`}
        placeholder="дд.мм.гггг"
        value={text}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint${error ? ` ${id}-err` : ''}`}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      <span id={`${id}-hint`} className="text-xs text-fg-muted">
        „15“ = 15-о число на периода · „+1“ = утре · „д“ = днес
      </span>
      {error ? (
        <span id={`${id}-err`} className="text-xs text-negative">
          {error}
        </span>
      ) : null}
    </div>
  );
}
