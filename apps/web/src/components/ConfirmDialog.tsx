'use client';
import * as RD from '@radix-ui/react-dialog';
import { useState, type ReactNode } from 'react';
import { Button, inputClass } from './ui';

/**
 * Confirmation for dangerous actions (PROMPT.md 5.3). For irreversible ones, pass
 * `typeToConfirm`: the user must type that word before the action button enables.
 * Focus is trapped inside; Esc cancels.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  typeToConfirm,
  onConfirm,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  typeToConfirm?: string;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const allowed = !typeToConfirm || typed.trim().toLowerCase() === typeToConfirm.toLowerCase();

  return (
    <RD.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        setTyped('');
      }}
    >
      <RD.Trigger asChild>{trigger}</RD.Trigger>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-overlay" />
        <RD.Content className="fixed top-1/3 left-1/2 z-50 w-[28rem] max-w-[90vw] -translate-x-1/2 rounded border border-line-strong bg-surface-raised p-5 text-fg">
          <RD.Title className="mb-2 text-lg font-semibold">{title}</RD.Title>
          <RD.Description className="mb-4 text-sm text-fg-muted">{description}</RD.Description>
          {typeToConfirm ? (
            <label className="mb-4 flex flex-col gap-1 text-xs text-fg-muted">
              Напишете „{typeToConfirm}“, за да потвърдите:
              <input
                className={inputClass}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoFocus
              />
            </label>
          ) : null}
          <div className="flex justify-end gap-2">
            <RD.Close asChild>
              <Button variant="secondary" inline>
                Отказ
              </Button>
            </RD.Close>
            <Button
              variant="danger"
              inline
              disabled={!allowed}
              onClick={() => {
                onConfirm();
                setOpen(false);
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
