'use client';

export function PrintButton() {
  return <button type="button" className="btn btn-primary" autoFocus onClick={() => window.print()}>Print</button>;
}
