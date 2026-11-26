'use client';

import { useEffect, useRef, useState } from 'react';
import { switchedOn } from '@/lib/add-customer';
import { customerDetail } from '@/lib/master-search';
import type { Customer } from '@/lib/schemas/masters';

/**
 * "Is this the same business?" The program never answers that itself, so no answer has the
 * focus: Enter, pressed on the way through a form, chooses nothing.
 */
export function CustomerChoice({ name, reason, candidates, message, takeFocus = false, onUse, onDifferent, onFix }: {
  name: string;
  /** The same GSTIN, a like-sounding name or the same phone, or (null) details that were refused. */
  reason: 'gstin' | 'similar' | null;
  candidates: readonly Customer[];
  message?: string | null;
  takeFocus?: boolean;
  onUse: (customer: Customer) => Promise<void> | void;
  onDifferent?: (() => Promise<void> | void) | undefined;
  onFix?: (() => Promise<void> | void) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const heading = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (takeFocus) heading.current?.focus();
  }, [takeFocus]);

  async function run(work: () => Promise<string | null>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setProblem(await work().catch(() => 'That did not work. Try again.'));
    setBusy(false);
  }
  const use = (candidate: Customer): Promise<void> =>
    run(async () => {
      const on = await switchedOn(candidate);
      if ('problem' in on) return on.problem;
      await onUse(on.customer);
      return null;
    });
  const answer = (work: () => Promise<void> | void): Promise<void> =>
    run(async () => {
      await work();
      return null;
    });

  const [first] = candidates;
  return (
    <div className="grid gap-2 rounded-[3px] border-l-[3px] border-warn bg-warn-bg p-3.5 text-left">
      <p ref={heading} tabIndex={-1} role="alert" className="font-semibold text-warn">
        {reason === 'gstin' && first ? `This GSTIN is already ${first.name}` : reason === 'similar' ? `Is ${name || 'this'} one of your customers?` : (message ?? 'Check the customer')}
      </p>
      {candidates.map((candidate) => (
        <div key={candidate.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-48 flex-1">
            <span className="block font-semibold">{candidate.name}{candidate.is_active ? '' : ' (inactive: switched on again if you use it)'}</span>
            <span className="block text-sm text-muted">{customerDetail(candidate)}{candidate.phone ? ` · ${candidate.phone}` : ''}</span>
          </span>
          <button type="button" className="btn" disabled={busy} onClick={() => void use(candidate)}>{reason === 'gstin' ? `Use ${candidate.name}` : 'Use this one'}</button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {reason === 'similar' && onDifferent ? <button type="button" className="btn" disabled={busy} onClick={() => void answer(onDifferent)}>No, a different customer</button> : null}
        {onFix ? <button type="button" className="btn" disabled={busy} onClick={() => void answer(onFix)}>{reason === 'gstin' ? 'Change the GSTIN' : 'Correct the details'}</button> : null}
      </div>
      {problem ? <p role="alert" className="text-sm font-semibold text-warn">{problem}</p> : null}
    </div>
  );
}
