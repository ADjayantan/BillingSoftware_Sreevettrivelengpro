'use server';

import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { safeNext } from '@/lib/safe-next';
import { createClient } from '@/lib/supabase/server';

const credentials = z.object({
  email: z.email().max(200),
  password: z.string().min(1).max(200),
  next: z.string().default(''),
});

export async function signIn(_previous: string | null, form: FormData): Promise<string | null> {
  const input = credentials.safeParse(Object.fromEntries(form));
  if (!input.success) return 'Enter your email and password';
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: input.data.email, password: input.data.password });
  if (isAuthRetryableFetchError(error)) return 'The cloud is not answering. Try again in a minute.';
  if (error) return 'That email or password is not right';
  redirect(safeNext(input.data.next));
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: 'local' });
  redirect('/login');
}
