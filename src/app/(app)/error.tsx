'use client';

export default function PageError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="card grid gap-3">
      <h1 className="page-title">This page could not open</h1>
      <p>Your bills are safe. Check the internet and try again. New bill works meanwhile.</p>
      <button className="btn btn-primary w-fit" type="button" onClick={reset}>Try again</button>
    </div>
  );
}
