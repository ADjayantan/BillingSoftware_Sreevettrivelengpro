'use client';

export default function PageError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="card grid gap-3">
      <h1 className="text-2xl font-bold">This page could not load</h1>
      <p>Your data is safe in the cloud. Check the internet connection and try again.</p>
      <button className="btn btn-primary w-fit" type="button" onClick={reset}>Try again</button>
    </div>
  );
}
