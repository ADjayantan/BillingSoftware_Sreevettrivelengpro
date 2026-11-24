import { LoginForm } from './form';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-4">
      <h1 className="text-3xl font-bold">StudFlow</h1>
      <LoginForm next={typeof next === 'string' ? next : ''} />
    </main>
  );
}
