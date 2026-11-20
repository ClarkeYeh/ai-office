/**
 * Derive a deterministic, single-line publication title. Limits count UTF-16
 * units conservatively; iteration by code point never splits a surrogate pair.
 * Callers retain the full source in the body/state. The adapter uses 256 as a
 * last-resort cap so older outbox commands can still be published.
 */
export function scmTitle(text: string, maxLength = 120): string {
  if (!Number.isInteger(maxLength) || maxLength < 2)
    throw new RangeError('Title limit must be an integer of at least 2');
  const title =
    text
      .split(/\r\n|[\n\r\u2028\u2029]/)
      .find((line) => line.trim())
      ?.replace(/\s+/gu, ' ')
      .trim() || 'Untitled';
  if (title.length <= maxLength) return title;
  let prefix = '';
  for (const point of title) {
    if (prefix.length + point.length > maxLength - 1) break;
    prefix += point;
  }
  return prefix.trimEnd() + '…';
}
