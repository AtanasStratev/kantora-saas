import type { ComponentProps, InputHTMLAttributes, ReactNode } from 'react';

/*
 * Token-based primitives (docs/design-system.md). Colors come ONLY from semantic tokens.
 * Interactive widgets that need state (select, dialog, amount/date inputs, table) live in
 * their own client components next to this file.
 */

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto mt-24 w-full max-w-sm rounded border border-line bg-surface-raised p-6">
      <h1 className="mb-4 text-xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}

export const inputClass =
  'rounded border border-line-strong bg-surface-sunken px-2 py-1.5 text-fg aria-[invalid=true]:border-negative';

export function Field({
  label,
  id,
  hint,
  error,
  ...input
}: {
  label: string;
  id: string;
  hint?: string;
  error?: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className="mb-3 flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        name={id}
        className={inputClass}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...input}
      />
      {hint ? (
        <span id={`${id}-hint`} className="text-xs text-fg-muted">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} className="text-xs text-negative">
          {error}
        </span>
      ) : null}
    </div>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
const BUTTON: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg',
  secondary: 'border border-line-strong text-fg',
  danger: 'border border-negative text-negative',
  ghost: 'text-accent underline',
};

export function Button({
  children,
  variant = 'primary',
  inline = false,
  className = '',
  ...props
}: ComponentProps<'button'> & { variant?: ButtonVariant; inline?: boolean }) {
  return (
    <button
      className={`${inline ? '' : 'w-full'} rounded px-3 py-1.5 font-medium disabled:opacity-60 ${BUTTON[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="mb-3 text-sm text-negative">
      {children}
    </p>
  );
}

export type BadgeKind = 'draft' | 'posted' | 'reversed' | 'locked' | 'warning';
const BADGE: Record<BadgeKind, { label: string; cls: string }> = {
  draft: { label: 'Чернова', cls: 'border-line-strong text-fg-muted' },
  posted: { label: 'Осчетоводен', cls: 'border-positive text-positive' },
  reversed: { label: 'Сторниран', cls: 'border-negative text-negative' },
  locked: { label: 'Заключен', cls: 'border-warning text-warning' },
  warning: { label: 'Внимание', cls: 'border-warning text-warning' },
};

export function Badge({ kind, children }: { kind: BadgeKind; children?: ReactNode }) {
  const b = BADGE[kind];
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-xs ${b.cls}`}>
      {children ?? b.label}
    </span>
  );
}

/** Empty states explain the next step and the key that does it (PROMPT.md 5.3). */
export function EmptyState({
  title,
  next,
  shortcut,
}: {
  title: string;
  next: string;
  shortcut?: string;
}) {
  return (
    <div className="rounded border border-dashed border-line-strong p-6 text-center">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-fg-muted">
        {next}
        {shortcut ? (
          <>
            {' '}
            <kbd className="rounded border border-line-strong px-1 text-xs">{shortcut}</kbd>
          </>
        ) : null}
      </p>
    </div>
  );
}

export type ValidationIssue = { message: string; fix: string; href?: string };

/** Validation results: what is wrong, how to fix it, and a link to the cause. */
export function ValidationList({ issues }: { issues: ValidationIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul role="list" aria-label="Грешки за поправяне" className="flex flex-col gap-2">
      {issues.map((i, n) => (
        <li key={n} className="rounded border border-negative px-3 py-2 text-sm">
          <div className="text-negative">{i.message}</div>
          <div className="text-fg-muted">
            {i.fix}
            {i.href ? (
              <>
                {' '}
                <a className="text-accent underline" href={i.href}>
                  Към документа
                </a>
              </>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong px-1 text-xs">{children}</kbd>;
}
