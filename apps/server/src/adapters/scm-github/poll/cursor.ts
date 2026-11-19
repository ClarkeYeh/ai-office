import { z } from 'zod';
import { PortError } from '../../../ports/errors.js';
import { ScmCursorSchema } from '../../../ports/refs.js';
import type { RepoScmRef, ScmCursor } from '../../../ports/refs.js';
/** Bounds keep the opaque cursor small enough to checkpoint every poll. */
export const CURSOR_LIMITS = {
  issues: 1000,
  prs: 200,
  refs: 300,
  markers: 500,
  bytes: 256 * 1024,
} as const;
const nat = z.number().int().nonnegative();
const status = z.enum(['pending', 'success', 'failure', 'none']);
const PollStateSchema = z.strictObject({
  v: z.literal(1),
  /** Lowercase `owner/name`: a cursor never crosses repositories. */
  r: z.string(),
  d: z.string(),
  /** Request key (endpoint + query) → ETag of the representation diffed into this state. */
  e: z.record(z.string(), z.string()),
  /** Max `updated_at` seen for Issues and comments; list scans start 2 minutes earlier. */
  iw: z.string().nullable(),
  cw: z.string().nullable(),
  refs: z.record(z.string(), z.string()),
  prs: z.record(
    z.string(),
    z.strictObject({
      s: z.enum(['open', 'closed', 'merged']),
      h: z.string(),
      b: z.string(),
      m: z.boolean().nullable(),
    }),
  ),
  ck: z.record(z.string(), status),
  /** Issue → short body hash and labels hash; 0 for PRs (only creation is reported). */
  is: z.record(
    z.string(),
    z.union([z.tuple([z.string(), z.string()]), z.literal(0)]),
  ),
  /** `<kind>:<commandId>` → object numbers or comment ids, latest creation, comment target. */
  mk: z.record(
    z.string(),
    z.strictObject({ n: z.array(nat), t: nat, g: nat.optional() }),
  ),
  /** Duplicate sets already reported, by marker key. */
  dp: z.record(z.string(), z.string()),
  /**
   * FX-C: the last emitted transition key per object (`pr:<n>`, `ck:<n>`,
   * `issue:<n>`, `ref:<branch>`). Absent in cursors written before FX-C.
   */
  k: z.record(z.string(), z.string()).optional(),
});
export type PollState = z.infer<typeof PollStateSchema>;
export const repoKey = (repo: RepoScmRef) =>
  `${repo.owner}/${repo.name}`.toLowerCase();
export function emptyState(repo: RepoScmRef, defaultBranch: string): PollState {
  return {
    v: 1,
    r: repoKey(repo),
    d: defaultBranch,
    e: {},
    iw: null,
    cw: null,
    refs: {},
    prs: {},
    ck: {},
    is: {},
    mk: {},
    dp: {},
    k: {},
  };
}
const invalid = () =>
  new PortError('validation', 'invalid_cursor', 'Invalid SCM cursor');
export function decodeCursor(cursor: ScmCursor, repo: RepoScmRef): PollState {
  let value: unknown;
  try {
    value = JSON.parse(cursor);
  } catch {
    throw invalid();
  }
  const parsed = PollStateSchema.safeParse(value);
  if (!parsed.success || parsed.data.r !== repoKey(repo)) throw invalid();
  return parsed.data;
}
/** Keeps the newest entries of a numeric-keyed map. */
function keepNewest<T>(
  map: Record<string, T>,
  limit: number,
  rank: (key: string, value: T) => number,
): Record<string, T> {
  const entries = Object.entries(map);
  if (entries.length <= limit) return map;
  return Object.fromEntries(
    entries.sort(([a, x], [b, y]) => rank(b, y) - rank(a, x)).slice(0, limit),
  );
}
export function encodeCursor(state: PollState): ScmCursor {
  const bounded: PollState = {
    ...state,
    is: keepNewest(state.is, CURSOR_LIMITS.issues, Number),
    // Open PRs outrank terminal ones; then newer numbers.
    prs: keepNewest(
      state.prs,
      CURSOR_LIMITS.prs,
      (key, pr) => Number(key) + (pr.s === 'open' ? 2 ** 40 : 0),
    ),
    refs: keepNewest(state.refs, CURSOR_LIMITS.refs, (key) =>
      key === state.d ? Infinity : 0,
    ),
    mk: keepNewest(state.mk, CURSOR_LIMITS.markers, (_, m) => m.t),
  };
  bounded.dp = Object.fromEntries(
    Object.entries(state.dp).filter(([key]) => key in bounded.mk),
  );
  // One chain key per object the cursor still tracks (FX-C).
  const pruneKeys = () => {
    bounded.k = Object.fromEntries(
      Object.entries(state.k ?? {}).filter(([key]) => {
        const split = key.indexOf(':');
        const [kind, id] = [key.slice(0, split), key.slice(split + 1)];
        return kind === 'issue'
          ? id in bounded.is
          : kind === 'ref'
            ? id in bounded.refs
            : (kind === 'pr' || kind === 'ck') && id in bounded.prs;
      }),
    );
  };
  pruneKeys();
  let text = JSON.stringify(bounded);
  // Last resort: shed the oldest Issues, then chain keys (an object without one
  // only restarts its chain), until the cursor fits.
  while (text.length > CURSOR_LIMITS.bytes) {
    const keys = Object.keys(bounded.is)
      .map(Number)
      .sort((a, b) => a - b);
    if (keys.length) {
      for (const key of keys.slice(0, Math.ceil(keys.length / 4)))
        delete bounded.is[key];
      pruneKeys();
    } else {
      const chains = Object.keys(bounded.k ?? {}).sort();
      if (!chains.length) throw invalid();
      for (const key of chains.slice(0, Math.ceil(chains.length / 4)))
        delete bounded.k![key];
    }
    text = JSON.stringify(bounded);
  }
  return ScmCursorSchema.parse(text);
}
