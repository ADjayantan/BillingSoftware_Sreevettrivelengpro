'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Option } from '@/lib/master-search';
import { focusNext } from './enter-advance';
import { useConnection } from './use-connection';

/** Type, arrow, Enter. Asks the server as you type, so no master list sits in memory. */
export function Typeahead<T>({ text, onText, search, onPick, placeholder, autoFocus = false, inputLabel, onEmptyEnter, add, picked }: {
  text: string;
  onText: (text: string) => void;
  search: (query: string) => Promise<Option<T>[]>;
  onPick: (option: Option<T>) => void;
  placeholder?: string;
  autoFocus?: boolean;
  inputLabel: string;
  /** Enter on an empty box, e.g. "no more lines": return true when handled. */
  onEmptyEnter?: () => boolean;
  /** The last entry of the list: what was typed is not in it. Enter takes it when nothing was found. */
  add?: { label: (text: string) => string; onAdd: (text: string) => void } | undefined;
  /** True when an entry is already chosen; false when one must be chosen from the list. */
  picked?: boolean | undefined;
}) {
  const listId = useId();
  const offline = useConnection() === 'offline';
  const [options, setOptions] = useState<Option<T>[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const adding = add && text.trim() !== '' ? add : undefined;
  const count = options.length + (adding ? 1 : 0);

  function lookUp(query: string): void {
    clearTimeout(timer.current);
    const ticket = ++latest.current;
    pending.current = true;
    timer.current = setTimeout(() => {
      void search(query).then((found) => {
        if (ticket !== latest.current) return; // a newer keystroke already asked
        pending.current = false;
        show(found);
      });
    }, 75);
  }

  /** A loose option is a guess: it is there to choose, but Enter alone does not take it. */
  function show(found: Option<T>[]): void {
    setOptions(found);
    setActive(found[0]?.loose ? -1 : 0);
    setOpen(true);
  }

  function pick(option: Option<T>): void {
    latest.current += 1;
    pending.current = false;
    setOpen(false);
    onPick(option);
  }

  function addTyped(typed: string): void {
    latest.current += 1;
    pending.current = false;
    setOpen(false);
    add?.onAdd(typed);
  }

  /** Enter straight after typing must not skip the suggestion that is still loading. */
  async function settle(input: HTMLInputElement): Promise<void> {
    clearTimeout(timer.current);
    const ticket = ++latest.current;
    const found = await search(input.value);
    if (ticket !== latest.current) return;
    pending.current = false;
    const [best] = found;
    if (best?.loose) return show(found);
    if (!best && adding) return addTyped(input.value);
    setOpen(false);
    if (best) pick(best);
    if (document.activeElement === input) focusNext(input);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) return lookUp(picked ? '' : text);
      const next = event.key === 'ArrowDown' ? active + 1 : Math.max(active, 0) - 1;
      setActive((next + count) % Math.max(1, count));
    } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      if (text.trim() === '') {
        setOpen(false);
        if (onEmptyEnter?.()) event.preventDefault();
        return;
      }
      if (pending.current) {
        event.preventDefault();
        void settle(input);
        return;
      }
      const option = open ? options[active] : undefined;
      if (option) {
        event.preventDefault();
        pick(option);
        focusNext(input);
      } else if (adding && open && active === options.length) {
        event.preventDefault();
        addTyped(text);
      } else if ((adding || picked === false) && !open) {
        event.preventDefault(); // nothing was chosen yet: not a reason to move on
        lookUp(text);
      } else {
        setOpen(false);
      }
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <input
        className="field"
        role="combobox"
        aria-label={inputLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 && active < count ? `${listId}-${active}` : undefined}
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={text}
        onChange={(event) => {
          onText(event.target.value);
          lookUp(event.target.value);
        }}
        onClick={() => {
          if (!open && picked !== undefined) lookUp(picked ? '' : text);
        }}
        onFocus={(event) => event.target.select()}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <ul id={listId} role="listbox" aria-label={inputLabel} className="absolute z-20 mt-1 max-h-80 w-full min-w-72 overflow-auto rounded-[3px] border border-line-2 bg-card shadow-[0_14px_30px_-12px_rgb(39_51_63/0.35)]">
          {options.length === 0 ? <li role="presentation" className="px-3 py-2 text-muted">No match</li> : null}
          {options.map((option, i) => (
            <li
              key={option.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`cursor-pointer px-3.5 py-2 ${i === active ? 'bg-soft shadow-[inset_3px_0_0_var(--accent)]' : 'hover:bg-sunken'}`}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(option);
              }}
            >
              <span className="block font-semibold">{option.label}</span>
              {option.detail ? <span className="block text-sm text-muted">{option.detail}</span> : null}
            </li>
          ))}
          {adding ? (
            <li
              id={`${listId}-${options.length}`}
              role="option"
              aria-selected={active === options.length}
              className={`cursor-pointer border-t border-line px-3.5 py-2 font-semibold text-accent ${active === options.length ? 'bg-soft shadow-[inset_3px_0_0_var(--accent)]' : 'hover:bg-sunken'}`}
              onMouseDown={(event) => {
                event.preventDefault();
                addTyped(text);
              }}
            >
              {adding.label(text.trim())}
            </li>
          ) : null}
          {offline ? <li role="presentation" className="border-t border-line px-3 py-1 text-sm text-muted">No internet · from this device</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
