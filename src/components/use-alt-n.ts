import { useEffect, useRef } from 'react';

/** Alt+N starts a new record on every screen. (accessKey needs other modifiers per browser.) */
export function useAltN(run: () => void): void {
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.code !== 'KeyN') return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
