'use client';

import { useActionState } from 'react';
import { enterAdvances } from '@/components/enter-advance';
import { Field, Notice } from '@/components/field';
import { signIn } from './actions';

export function LoginForm({ next }: { next: string }) {
  const [error, action, pending] = useActionState(signIn, null);
  return (
    <form action={action} onKeyDown={enterAdvances} className="grid w-full max-w-[380px] gap-4">
      <div>
        <h2 className="page-title">Sign in</h2>
        <p className="mt-1 text-muted">Use the e-mail the owner gave you.</p>
      </div>
      <input type="hidden" name="next" value={next} />
      <Field label="E-mail">
        <input className="field" name="email" type="email" autoComplete="username" required autoFocus />
      </Field>
      <Field label="Password">
        <input className="field" name="password" type="password" autoComplete="current-password" required />
      </Field>
      {error ? <Notice tone="warn">{error}</Notice> : null}
      <button className="btn btn-primary min-h-13" type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}
