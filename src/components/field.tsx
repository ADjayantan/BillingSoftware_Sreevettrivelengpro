import type { ReactNode } from 'react';

export function Field({ label, hint, error, children, className = '' }: {
  label: string;
  hint?: ReactNode;
  error?: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-sm font-semibold">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="mt-1 block text-sm font-semibold text-warn">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-sm text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn'; children: ReactNode }) {
  return (
    <p
      role={tone === 'warn' ? 'alert' : 'status'}
      className={`rounded-md border px-3 py-2 font-semibold ${tone === 'warn' ? 'border-warn bg-warn-bg text-warn' : 'border-accent text-accent'}`}
    >
      {children}
    </p>
  );
}
