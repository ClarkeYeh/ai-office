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
  constructor(
    message = 'Tape leak scan failed',
    /** Safe location and rule labels only (M5-FX-TAPEDIAG); never values. */
    readonly label?: string,
  ) {
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
const TOKEN =
  /\b(?:gh[a-z]_+[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|aio_seat_[A-Za-z0-9_-]+)/;
const HOME = /\/(?:Users|home)\/|[A-Z]:\\Users\\/;
const ALLOWED_EMAIL =
  /^(?:noreply@github\.com|[A-Za-z0-9+_-]+@users\.noreply\.github\.com|[^@]+@example\.invalid)$/i;

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

/** The sensitive-text rule a string trips, if any (same order as the scan). */
function sensitiveRule(value: string): string | undefined {
  const text = value.replace(/%([a-f0-9]{2})/gi, (_, byte: string) =>
    String.fromCharCode(parseInt(byte, 16)),
  );
  if (TOKEN.test(text)) return 'token prefix';
  if (HOME.test(text)) return 'home path';
  if (/PRIVATE KEY/.test(text)) return 'private key';
  if ((text.match(EMAIL) ?? []).some((email) => !ALLOWED_EMAIL.test(email)))
    return 'email';
  return undefined;
}

function assertNoSensitiveText(value: string): void {
  if (sensitiveRule(value) !== undefined) throw new TapeLeakError();
}

// Masking rules of the base redactor, in its order (labels only).
const MASK_RULES: readonly [string, RegExp][] = [
  ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['url', /[a-z][a-z0-9+.-]*:\/\/[^/\s"<>]+/i],
  ['token prefix', TOKEN],
  ['email', /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['home path', HOME],
  [
    'domain',
    /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|org|net|edu|gov|mil|io|dev|app|ai|co|uk|tw|local|internal|lan)\b/i,
  ],
  ['ip address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
  [
    'hostname',
    /\b(?:localhost|[a-z0-9-]+-(?:MacBook|iMac|Mac|PC)(?:-[a-z0-9-]+)?)\b/i,
  ],
];
const BODY_KEY =
  /^(?:input|output|tool_?input|tool_?output|arguments|stdout|stderr|transcript|file_?contents?|command_?output|agent_?text|body|content|text)$/i;
const SECRET_KEY =
  /(?:password|secret|token|api[_-]?key|authorization|cookie|private[_-]?key)/i;
const HOST_KEY = /^(?:host|hostname|host_name|machine|machineName)$/i;

/** Which part of a tape a JSON path names: section and field kind only. */
function where(path: readonly (string | number)[]): [string, string] {
  const [top, , field] = path;
  if (top === 'recordings') {
    const kind =
      field === 'path' || field === 'pathTemplate'
        ? 'request path'
        : field === 'query'
          ? 'request query'
          : field === 'headers'
            ? 'response header'
            : field === 'response'
              ? 'response body'
              : 'request metadata';
    return ['recordings', kind];
  }
  if (top === 'pushes')
    return [
      'pushes',
      field === 'branch' || field === 'base'
        ? 'push ref'
        : field === 'sha'
          ? 'push sha'
          : 'push signature',
    ];
  if (top === 'clockReads') return ['clockReads', 'clock read'];
  return ['other', 'envelope'];
}

/**
 * M5-T16 / FX-TAPEDIAG: name the section, field kind and rule of the first
 * leak in a tape (`recordings/request query/entropy`). Never a value, an
 * offset or a hash of one, so refusals stay safe to print and report.
 */
export function diagnoseTapeLeak(value: unknown): string {
  const label = (path: (string | number)[], rule: string, key: boolean) => {
    const [section, kind] = where(path);
    return `${section}/${kind}${key ? ' key' : ''}/${rule}`;
  };
  // Sensitive-text rules first: the normalizer and the envelope scan both apply them.
  const sensitive = (
    v: unknown,
    path: (string | number)[],
  ): string | undefined => {
    if (typeof v === 'string') {
      const rule = sensitiveRule(v);
      return rule && label(path, rule, false);
    }
    if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) {
        const found = sensitive(x, [...path, i]);
        if (found) return found;
      }
      return undefined;
    }
    if (isRecord(v))
      for (const [k, x] of Object.entries(v)) {
        const rule = sensitiveRule(k);
        if (rule) return label([...path, k], rule, true);
        const found = sensitive(x, [...path, k]);
        if (found) return found;
      }
    return undefined;
  };
  const first = sensitive(value, []);
  if (first) return first;
  // Then the first field the fixture redactor would change (its exemptions apply).
  let sanitized: unknown;
  try {
    sanitized = redactor.sanitize(value);
  } catch {
    return 'other/envelope/key collision';
  }
  const textRule = (text: string) =>
    MASK_RULES.find(([, rule]) => rule.test(text))?.[0] ?? 'entropy';
  const diff = (
    raw: unknown,
    clean: unknown,
    path: (string | number)[],
  ): string | undefined => {
    if (JSON.stringify(raw) === JSON.stringify(clean)) return undefined;
    const key = path.at(-1);
    if (typeof key === 'string' && isRecord(clean) === false) {
      if (BODY_KEY.test(key)) return label(path, 'unsummarized body', false);
      if (SECRET_KEY.test(key)) return label(path, 'secret field', false);
      if (HOST_KEY.test(key)) return label(path, 'host field', false);
    }
    if (typeof raw === 'string') return label(path, textRule(raw), false);
    if (Array.isArray(raw) && Array.isArray(clean)) {
      for (const [i, x] of raw.entries()) {
        const found = diff(x, clean[i], [...path, i]);
        if (found) return found;
      }
    } else if (isRecord(raw) && isRecord(clean)) {
      const cleanKeys = Object.keys(clean);
      for (const [i, [k, x]] of Object.entries(raw).entries()) {
        if (cleanKeys[i] !== k) return label([...path, k], textRule(k), true);
        const found = diff(x, clean[k], [...path, k]);
        if (found) return found;
      }
    }
    return label(path, 'structure', false);
  };
  return diff(value, sanitized, []) ?? 'other/envelope/unclassified';
}

/** Check the complete normalized envelope, including structural request metadata. */
export function assertTapeSafe(value: unknown): void {
  // Token and email checks always see concrete request paths too.
  if (
    sensitiveRule(JSON.stringify(value)) !== undefined ||
    redactor.hasLeaks(value)
  )
    throw new TapeLeakError(undefined, diagnoseTapeLeak(value));
}
