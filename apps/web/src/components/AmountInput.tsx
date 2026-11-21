'use client';
import { formatAmount, parseAmount } from '@kantora/domain';
import { useId, useState } from 'react';
import { inputClass } from './ui';

/**
 * Amount entry: accepts "1 234,56", "1234.56" etc.; shows Bulgarian formatting on blur.
 * `onValue` receives a plain decimal string ("1234.56") or null while invalid.
 */
export function AmountInput({
  label,
  defaultValue = '',
  maxDecimals = 2,
  onValue,
}: {
  label: string;
  defaultValue?: string;
  maxDecimals?: number;
  onValue?: (value: string | null) => void;
}) {
  const id = useId();
  const [text, setText] = useState(defaultValue ? formatAmount(defaultValue, maxDecimals) : '');
  const [error, setError] = useState('');

  function commit() {
    if (text.trim() === '') {
      setError('');
      onValue?.(null);
      return;
    }
    const r = parseAmount(text, maxDecimals);
    if (r.ok) {
      setError('');
      setText(formatAmount(r.value, maxDecimals));
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
        inputMode="decimal"
        className={`${inputClass} text-right tabular-nums`}
        value={text}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {error ? (
        <span id={`${id}-err`} className="text-xs text-negative">
          {error}
        </span>
      ) : null}
    </div>
  );
}
