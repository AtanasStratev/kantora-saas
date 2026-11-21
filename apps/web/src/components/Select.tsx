'use client';
import * as RS from '@radix-ui/react-select';
import { useId } from 'react';
import { inputClass } from './ui';

export type Option = { value: string; label: string };

/** Accessible select (Radix): opens with Space/Enter/↓, type-ahead, Esc closes. */
export function Select({
  label,
  options,
  value,
  onValueChange,
  placeholder = 'Изберете…',
}: {
  label: string;
  options: Option[];
  value?: string;
  onValueChange?: (v: string) => void;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="mb-3 flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-fg-muted">
        {label}
      </label>
      <RS.Root
        {...(value !== undefined ? { value } : {})}
        {...(onValueChange ? { onValueChange } : {})}
      >
        <RS.Trigger id={id} className={`${inputClass} flex items-center justify-between text-left`}>
          <RS.Value placeholder={placeholder} />
          <RS.Icon aria-hidden>▾</RS.Icon>
        </RS.Trigger>
        <RS.Portal>
          <RS.Content
            position="popper"
            sideOffset={4}
            className="z-50 min-w-[var(--radix-select-trigger-width)] rounded border border-line-strong bg-surface-raised text-fg shadow-lg"
          >
            <RS.Viewport className="p-1">
              {options.map((o) => (
                <RS.Item
                  key={o.value}
                  value={o.value}
                  className="cursor-default rounded px-2 py-1 outline-none data-[highlighted]:bg-surface-selected"
                >
                  <RS.ItemText>{o.label}</RS.ItemText>
                </RS.Item>
              ))}
            </RS.Viewport>
          </RS.Content>
        </RS.Portal>
      </RS.Root>
    </div>
  );
}
