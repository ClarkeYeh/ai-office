import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function media(): MediaQueryList | null {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY)
    : null;
}

function subscribe(onChange: () => void): () => void {
  const list = media();
  list?.addEventListener('change', onChange);
  return () => list?.removeEventListener('change', onChange);
}

const snapshot = () => media()?.matches ?? false;

/** D4: `prefers-reduced-motion: reduce` stops every animation; `override` wins. */
export function useReducedMotion(override?: boolean): boolean {
  const preferred = useSyncExternalStore(subscribe, snapshot, () => false);
  return override ?? preferred;
}
