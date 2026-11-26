import type { ReactNode } from 'react';

export function Field({ label, hint, error, children, className = '' }: {
  label: string;
  hint?: ReactNode;
  error?: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="mb-1 block text-[13.5px] text-ink-2">{label}</span>
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
      className={`rounded-[3px] border-l-[3px] px-3.5 py-2.5 ${tone === 'warn' ? 'border-warn bg-warn-bg text-warn' : 'border-paid bg-paid-bg text-paid'}`}
    >
      {children}
    </p>
  );
}
