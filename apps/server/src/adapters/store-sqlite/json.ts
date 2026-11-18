/** Reject values SQLite cannot round-trip instead of silently storing SQL NULL. */
export function json(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined)
    throw new TypeError('Value is not JSON serializable');
  return result;
}
