import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

/* Minimal token-based primitives. The full design system (Radix, /design route) comes next. */

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto mt-24 w-full max-w-sm rounded border border-line bg-surface-raised p-6">
      <h1 className="mb-4 text-xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}

export function Field({
  label,
  id,
  hint,
  ...input
}: { label: string; id: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="mb-3 flex flex-col gap-1">
      <label htmlFor={id} className="text-fg-muted text-xs">
        {label}
      </label>
      <input
        id={id}
        name={id}
        className="rounded border border-line-strong bg-surface-sunken px-2 py-1.5 text-fg"
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...input}
      />
      {hint ? (
        <span id={`${id}-hint`} className="text-fg-muted text-xs">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function Button({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className="w-full rounded bg-accent px-3 py-1.5 font-medium text-accent-fg disabled:opacity-60"
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
