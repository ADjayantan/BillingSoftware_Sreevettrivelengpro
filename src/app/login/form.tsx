'use client';

import { useActionState } from 'react';
import { enterAdvances } from '@/components/enter-advance';
import { Field, Notice } from '@/components/field';
import { signIn } from './actions';

export function LoginForm({ next }: { next: string }) {
  const [error, action, pending] = useActionState(signIn, null);
  return (
    <form action={action} onKeyDown={enterAdvances} className="card grid gap-4">
      <input type="hidden" name="next" value={next} />
      <Field label="Email">
        <input className="field" name="email" type="email" autoComplete="username" required autoFocus />
      </Field>
      <Field label="Password">
        <input className="field" name="password" type="password" autoComplete="current-password" required />
      </Field>
      {error ? <Notice tone="warn">{error}</Notice> : null}
      <button className="btn btn-primary" type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}
