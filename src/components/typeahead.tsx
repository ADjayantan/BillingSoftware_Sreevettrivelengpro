'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Option } from '@/lib/master-search';
import { focusNext } from './enter-advance';
import { useConnection } from './use-connection';

/** Type, arrow, Enter. Asks the server as you type, so no master list sits in memory. */
export function Typeahead<T>({ text, onText, search, onPick, placeholder, autoFocus = false, inputLabel, onEmptyEnter }: {
  text: string;
  onText: (text: string) => void;
  search: (query: string) => Promise<Option<T>[]>;
  onPick: (option: Option<T>) => void;
  placeholder?: string;
  autoFocus?: boolean;
  inputLabel: string;
  /** Enter on an empty box, e.g. "no more lines": return true when handled. */
  onEmptyEnter?: () => boolean;
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

  function lookUp(query: string): void {
    clearTimeout(timer.current);
    const ticket = ++latest.current;
    pending.current = true;
    timer.current = setTimeout(() => {
      void search(query).then((found) => {
        if (ticket !== latest.current) return; // a newer keystroke already asked
        pending.current = false;
        setOptions(found);
        setActive(0);
        setOpen(true);
      });
    }, 150);
  }

  function pick(option: Option<T>): void {
    latest.current += 1;
    pending.current = false;
    setOpen(false);
    onPick(option);
  }

  /** Enter straight after typing must not skip the suggestion that is still loading. */
  async function settle(input: HTMLInputElement): Promise<void> {
    clearTimeout(timer.current);
    const ticket = ++latest.current;
    const [best] = await search(input.value);
    if (ticket !== latest.current) return;
    pending.current = false;
    setOpen(false);
    if (best) pick(best);
    if (document.activeElement === input) focusNext(input);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) return lookUp(text);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((active + step + options.length) % Math.max(1, options.length));
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
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={text}
        onChange={(event) => {
          onText(event.target.value);
          lookUp(event.target.value);
        }}
        onFocus={(event) => event.target.select()}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <ul id={listId} role="listbox" aria-label={inputLabel} className="absolute z-20 mt-1 max-h-80 w-full min-w-72 overflow-auto rounded-md border border-line bg-card shadow-lg">
          {options.length === 0 ? <li className="px-3 py-2 text-muted">No match</li> : null}
          {options.map((option, i) => (
            <li
              key={option.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`cursor-pointer px-3 py-2 ${i === active ? 'bg-accent text-accent-ink' : ''}`}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(option);
              }}
            >
              <span className="block font-semibold">{option.label}</span>
              {option.detail ? <span className="block text-sm opacity-80">{option.detail}</span> : null}
            </li>
          ))}
          {offline ? <li role="presentation" className="border-t border-line px-3 py-1 text-sm text-muted">Offline Mode · from this PC</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
