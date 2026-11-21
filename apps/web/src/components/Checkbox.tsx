'use client';
import * as RC from '@radix-ui/react-checkbox';
import { useId } from 'react';

export function Checkbox({
  label,
  defaultChecked,
  onCheckedChange,
}: {
  label: string;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="mb-3 flex items-center gap-2">
      <RC.Root
        id={id}
        {...(defaultChecked !== undefined ? { defaultChecked } : {})}
        onCheckedChange={(c) => onCheckedChange?.(c === true)}
        className="flex h-4 w-4 items-center justify-center rounded border border-line-strong bg-surface-sunken data-[state=checked]:border-accent data-[state=checked]:bg-accent"
      >
        <RC.Indicator className="text-xs leading-none text-accent-fg">✓</RC.Indicator>
      </RC.Root>
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
    </div>
  );
}
