import type { KeyboardEvent } from 'react';

/** Moves to the next field of the form, skipping those marked data-enter-skip (still on Tab). */
export function focusNext(target: HTMLElement): void {
  const form = target.closest('form');
  if (!form) return;
  const fields = [...form.querySelectorAll<HTMLElement>('input, select, textarea, button[type="submit"]')].filter(
    (field) => field === target || (!field.hasAttribute('disabled') && !field.hasAttribute('data-enter-skip') && field.offsetParent !== null),
  );
  const next = fields[fields.indexOf(target) + 1];
  next?.focus();
  if (next instanceof HTMLInputElement && next.type !== 'date' && next.type !== 'checkbox') next.select();
}

/**
 * Enter moves on, as on a desk calculator; from the last field it lands on Save.
 * Widgets that use Enter themselves (an open suggestion list) call preventDefault first.
 */
export function enterAdvances(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'Enter' || event.defaultPrevented) return;
  const target = event.target;
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    if (target instanceof HTMLElement) target.closest('form')?.requestSubmit();
    return;
  }
  if (event.altKey || event.shiftKey || !(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  event.preventDefault();
  focusNext(target);
}
