import { createRedactor } from '@ai-office/redaction';

/** Fixture-only exception; keep in sync with scripts/fixtures/github-redaction.ts. */
export function githubRefRedactor(base: ReturnType<typeof createRedactor>) {
  const safeRef = (value: string) =>
    /^refs\/heads\/ai-office\/t[a-f0-9]{12}[-/][A-Za-z0-9._/-]+$/.test(value) &&
    !/\/(?:Users|home)\//.test(value) &&
    value
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          base.maskText(part) === part,
      );
  const restore = (original: unknown, sanitized: unknown): unknown => {
    if (Array.isArray(original) && Array.isArray(sanitized))
      return original.map((v, i) => restore(v, sanitized[i]));
    if (
      original &&
      sanitized &&
      typeof original === 'object' &&
      typeof sanitized === 'object'
    ) {
      const clean = sanitized as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(clean).map(([key, value]) => {
          const raw = (original as Record<string, unknown>)[key];
          return [
            key,
            key === 'ref' && typeof raw === 'string' && safeRef(raw)
              ? raw
              : restore(raw, value),
          ];
        }),
      );
    }
    return sanitized;
  };
  const sanitize = (value: unknown) => restore(value, base.sanitize(value));
  return {
    ...base,
    maskText: (value: string) =>
      safeRef(value) ? value : base.maskText(value),
    sanitize,
    hasLeaks: (value: unknown) =>
      JSON.stringify(sanitize(value)) !== JSON.stringify(value),
  };
}
