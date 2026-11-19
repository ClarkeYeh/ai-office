import type { Translate } from './messages.js';

/** Compact token counts for nameplates and the whiteboard: 950, 1.2k, 148k, 1.04M. */
export function formatTokens(tokens: number): string {
  const n = Math.max(0, Math.round(tokens));
  if (n < 1000) return String(n);
  if (n < 10_000) return `${trim((n / 1000).toFixed(1))}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${trim((n / 1_000_000).toFixed(2))}M`;
}
const trim = (s: string) => s.replace(/\.?0+$/, '');

/**
 * Elapsed time since `sinceIso` (G7). `precise` keeps seconds below ten minutes,
 * for "waiting for you" counters; otherwise whole minutes once past one minute.
 */
export function formatElapsed(
  t: Translate,
  sinceIso: string,
  now: number,
  precise = false,
): string {
  const total = Math.max(0, Math.floor((now - Date.parse(sinceIso)) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return t('office.elapsed.hours', { h, m });
  if (m === 0) return t('office.elapsed.seconds', { s });
  if (precise && m < 10) return t('office.elapsed.minutesSeconds', { m, s });
  return t('office.elapsed.minutes', { m });
}

export const listOf = (t: Translate, items: readonly string[]) =>
  items.join(t('office.list.separator'));
