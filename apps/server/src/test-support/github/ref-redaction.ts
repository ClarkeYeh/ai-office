import { createRedactor } from '@ai-office/redaction';

const id = '[1-9]\\d{0,9}';
const sha = '[a-f0-9]{40}';
const ref =
  'main|ai-office(?:%2F|/)[A-Za-z0-9._-]+(?:(?:%2F|/)[A-Za-z0-9._-]+)*';
const rev = `(?:${sha}|${ref})`;
const root = '/repos/ClarkeYeh/ai-office-spike';
/**
 * Recorded request paths the entropy rule may skip: an endpoint template and
 * the exact concrete form it abstracts (spike root, numeric ids, refs, SHAs).
 */
const structuralPaths = new Map<string, RegExp>(
  (
    [
      ['/issues/{number}', `/issues/${id}`],
      ['/issues/{number}/comments', `/issues/${id}/comments`],
      ['/issues/{number}/labels', `/issues/${id}/labels`],
      ['/issues/comments/{id}', `/issues/comments/${id}`],
      ['/pulls/{number}', `/pulls/${id}`],
      ['/pulls/{number}/comments', `/pulls/${id}/comments`],
      ['/pulls/{number}/reviews', `/pulls/${id}/reviews`],
      ['/commits/{ref}', `/commits/${sha}/(?:check-runs|status)`],
      ['/branches/{ref}', `/branches/(?:${ref})(?:/protection)?`],
      ['/compare/{ref}', `/compare/${rev}\\.\\.\\.${rev}`],
      ['/git/ref/heads/{ref}', `/git/ref/heads/(?:${ref})`],
      ['/git/refs/heads/{ref}', `/git/refs/heads/(?:${ref})`],
    ] as const
  ).map(([template, concrete]) => [
    '/repos/{owner}/{repo}' + template,
    new RegExp(`^${root}${concrete}$`),
  ]),
);
/** A request signature's `path`; token-prefix and email checks still apply. */
const structuralPath = (value: Record<string, unknown>) =>
  typeof value.path === 'string' &&
  typeof value.pathTemplate === 'string' &&
  structuralPaths.get(value.pathTemplate)?.test(value.path) === true &&
  !/\b(?:gh[a-z]_|github_pat_|sk-|aio_seat_)|@/i.test(value.path);

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
  // A product branch `ai-office/<shortId>-<slug>` as GitHub reports it in a
  // PR's head/base `ref` (an owner hand-merge observation, M3-FX-TAPE).
  const productRef = (value: string) =>
    value.length <= 120 &&
    /^ai-office\/[a-f0-9]{12}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) &&
    !/\b(?:gh[a-z]_|github_pat_|sk-|aio_seat_)/.test(value);
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
      const signature = structuralPath(original as Record<string, unknown>);
      return Object.fromEntries(
        Object.entries(clean).map(([key, value]) => {
          const raw = (original as Record<string, unknown>)[key];
          return [
            key,
            (key === 'ref' &&
              typeof raw === 'string' &&
              (safeRef(raw) || productRef(raw))) ||
            (key === 'path' && signature)
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
      safeRef(value) || productRef(value) ? value : base.maskText(value),
    sanitize,
    hasLeaks: (value: unknown) =>
      JSON.stringify(sanitize(value)) !== JSON.stringify(value),
  };
}
