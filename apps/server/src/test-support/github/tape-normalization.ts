import { githubRefRedactor } from './ref-redaction.js';
import { createRedactor } from '@ai-office/redaction';
import { API, ROOT, REPO } from './safety.js';

const htmlRoot = `https://github.com/${REPO}`;
const redactor = githubRefRedactor(
  createRedactor({ preservedRepoUrls: [htmlRoot] }),
);

/** A tape leak scan failure: a harness error, never a GitHub outcome. */
export class TapeLeakError extends Error {
  override readonly name = 'TapeLeakError';
  constructor(message = 'Tape leak scan failed') {
    super(message);
  }
}

const GITHUB_NOREPLY = '<github-noreply>';
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
// A git commit object (commit, branch.commit, compare and pulls/commits rows):
// its author/committer are git signatures, never GitHub user objects.
const isGitCommit = (v: Record<string, unknown>) =>
  typeof v.message === 'string' && isRecord(v.tree);
const isSignature = (v: unknown): v is Record<string, unknown> =>
  isRecord(v) &&
  typeof v.name === 'string' &&
  typeof v.email === 'string' &&
  typeof v.date === 'string' &&
  Object.keys(v).every((k) => ['name', 'email', 'date'].includes(k));

// Public service senders of commit-message trailers (Co-Authored-By), exact
// literals only; the users.noreply form is GitHub's per-user noreply.
const serviceNoreply = (email: string): string | undefined =>
  email === 'noreply@anthropic.com'
    ? '<anthropic-noreply>'
    : email === 'noreply@github.com' ||
        /^[A-Za-z0-9+_-]+@users\.noreply\.github\.com$/.test(email)
      ? GITHUB_NOREPLY
      : undefined;
const EMAIL = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Per-tape identities; normalization is idempotent and never changes request hashes. */
export class TapeNormalizer {
  private readonly nodes = new Map<string, string>();
  value<T>(value: T): T {
    const walk = (v: unknown, key = ''): unknown => {
      if (typeof v === 'string') {
        const publicRemote = [
          `git@github.com:${REPO}.git`,
          `git://github.com/${REPO}.git`,
          `https://github.com/${REPO}.git`,
        ].includes(v);
        // Exact public remotes only; do not exempt arbitrary SSH/email strings.
        if (!publicRemote) assertNoSensitiveText(v);
        // Opaque text must be hashed unchanged so known request bodies rehydrate.
        if (
          /^(?:body|content|text|input|output|preview|spec|prompt|question|objective|stderrLines)$/i.test(
            key,
          )
        )
          return v;
        if (publicRemote) return htmlRoot + '/__fixtures__/clone';
        if (
          /^(?:noreply@github\.com|[A-Za-z0-9+_-]+@users\.noreply\.github\.com)$/.test(
            v,
          )
        )
          return GITHUB_NOREPLY;
        if (key === 'node_id' && !/^NODE_\d{6}$/.test(v)) {
          // Do not turn a secret masquerading as an ID into an innocent placeholder.
          assertNoSensitiveText(v);
          let mapped = this.nodes.get(v);
          if (!mapped) {
            mapped = `NODE_${String(this.nodes.size + 1).padStart(6, '0')}`;
            this.nodes.set(v, mapped);
          }
          return mapped;
        }
        if (/^https:\/\//.test(v)) {
          const url = new URL(v);
          if (
            url.origin === API &&
            (url.pathname === ROOT || url.pathname.startsWith(ROOT + '/'))
          ) {
            assertNoSensitiveText(v);
            if (url.username || url.password)
              throw new TapeLeakError('Unsafe tape URL');
            // Valid, fixture-safe URLs; adapter requests retain their original API paths.
            return (
              htmlRoot +
              '/__api__' +
              url.pathname.slice(ROOT.length) +
              url.search +
              url.hash
            );
          }
          if (
            url.origin === API &&
            /^\/users\/[A-Za-z0-9-]+(?:\/|$)/.test(url.pathname)
          ) {
            if (url.username || url.password)
              throw new TapeLeakError('Unsafe tape URL');
            return (
              htmlRoot +
              '/__users__' +
              url.pathname.slice('/users'.length) +
              url.search +
              url.hash
            );
          }
          if (url.hostname === 'avatars.githubusercontent.com') {
            assertNoSensitiveText(v);
            if (url.username || url.password)
              throw new TapeLeakError('Unsafe tape URL');
            return htmlRoot + '/__fixtures__/avatar.png';
          }
        }
        return v;
      }
      if (Array.isArray(v)) return v.map((x) => walk(x));
      if (isRecord(v)) {
        const commit = isGitCommit(v);
        return Object.fromEntries(
          Object.entries(v).map(([k, x]) => [
            k,
            // The adapter never reads commit emails; old spike history carries a
            // private one, so it is replaced before the leak scan sees it.
            walk(
              commit && (k === 'author' || k === 'committer') && isSignature(x)
                ? { ...x, email: GITHUB_NOREPLY }
                : commit && k === 'message' && typeof x === 'string'
                  ? x.replace(EMAIL, (m) => serviceNoreply(m) ?? m)
                  : x,
              k,
            ),
          ]),
        );
      }
      return v;
    };
    return walk(value) as T;
  }
}

function assertNoSensitiveText(value: string): void {
  const text = value.replace(/%([a-f0-9]{2})/gi, (_, byte: string) =>
    String.fromCharCode(parseInt(byte, 16)),
  );
  if (
    /\b(?:gh[a-z]_+[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|aio_seat_[A-Za-z0-9_-]+)|\/(?:Users|home)\/|[A-Z]:\\Users\\|PRIVATE KEY/.test(
      text,
    )
  )
    throw new TapeLeakError();
  for (const email of text.match(EMAIL) ?? []) {
    if (
      !/^(?:noreply@github\.com|[A-Za-z0-9+_-]+@users\.noreply\.github\.com|[^@]+@example\.invalid)$/i.test(
        email,
      )
    )
      throw new TapeLeakError();
  }
}

/** Check the complete normalized envelope, including structural request metadata. */
export function assertTapeSafe(value: unknown): void {
  // Token and email checks always see concrete request paths too.
  assertNoSensitiveText(JSON.stringify(value));
  if (redactor.hasLeaks(value)) throw new TapeLeakError();
}
