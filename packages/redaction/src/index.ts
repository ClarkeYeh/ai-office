import { sha256 } from './sha256.js';

const replacement = '<redacted>';
const bodyKeys =
  /^(?:input|output|tool_?input|tool_?output|arguments|stdout|stderr|transcript|file_?contents?|command_?output|agent_?text|body|content|text)$/i;
const secretKeys =
  /(?:password|secret|token|api[_-]?key|authorization|cookie|private[_-]?key)/i;
const hostKeys = /^(?:host|hostname|host_name|machine|machineName)$/i;
// IDs remain replayable; explicit provider-token and secret-field rules run first.
const structuredId =
  /^(?:[0-7][0-9A-HJKMNP-TV-Z]{25}|[a-f0-9]{40}|[a-f0-9]{64}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}|(?:term|ctx|task|run|msg)_(?:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}|[a-f0-9]{12,32}))$/i;
const summaryPattern = /^<redacted length=\d+ sha256=[a-f0-9]{64}>$/;

// Conservative heuristics: false positives should be reviewed, never allowlisted blindly.
export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  /[a-z][a-z0-9+.-]*:\/\/[^/\s"<>]+/gi,
  /\b(?:gh[a-z]_+[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|aio_seat_[A-Za-z0-9_-]+|aio_ctl_[A-Za-z0-9_-]+)/g,
  /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  /\/(?:Users|home)\/(?!<redacted>)[^/\s"<>]+/g,
  /\b[A-Z]:\\Users\\(?!<redacted>)[^\\\s"<>]+/gi,
  /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|org|net|edu|gov|mil|io|dev|app|ai|co|uk|tw|local|internal|lan)\b/gi,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  /\b(?:localhost|[a-z0-9-]+-(?:MacBook|iMac|Mac|PC)(?:-[a-z0-9-]+)?)\b/gi,
];

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.values()].reduce((sum, n) => {
    const p = n / value.length;
    return sum - p * Math.log2(p);
  }, 0);
}

function maskPlainText(value: string): string {
  // Only our exact metadata representation is exempt from entropy scanning.
  return value
    .split(/(<redacted length=\d+ sha256=[a-f0-9]{64}>)/)
    .map((part) => {
      if (summaryPattern.test(part)) return part;
      let masked = part;
      for (const pattern of SECRET_PATTERNS) {
        masked = masked.replace(pattern, (match) => {
          if (/^\/(Users|home)\//.test(match))
            return match.split('/').slice(0, 2).join('/') + '/' + replacement;
          if (/^[A-Z]:\\Users\\/i.test(match))
            return match.slice(0, 9) + replacement;
          return replacement;
        });
      }
      return masked.replace(/[A-Za-z0-9_+/=-]{20,}/g, (candidate) =>
        !structuredId.test(candidate) &&
        (entropy(candidate) >= 4.2 ||
          (/\d/.test(candidate) && entropy(candidate) >= 3.5))
          ? replacement
          : candidate,
      );
    })
    .join('');
}

export function summarize(value: unknown): string {
  if (typeof value === 'string' && summaryPattern.test(value)) return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) throw new TypeError('Value is not JSON serializable');
  const bytes = new TextEncoder().encode(text);
  return `<redacted length=${bytes.length} sha256=${sha256(bytes)}>`;
}

export interface RedactorOptions {
  preservedRepoUrls?: readonly string[];
}

/** No URLs are preserved unless the caller explicitly supplies repository roots. */
export function createRedactor({
  preservedRepoUrls = [],
}: RedactorOptions = {}) {
  const repositories = preservedRepoUrls.map((value) => {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname === '/'
    )
      throw new TypeError('Expected an HTTPS repository root URL');
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url;
  });
  // URL parsing limits preservation to configured roots and prevents prefix
  // lookalikes, userinfo and query credentials from bypassing masking.
  function maskText(value: string): string {
    return value
      .split(/(https?:\/\/[^\s"'<>]+)/gi)
      .map((part) => {
        if (!/^https?:\/\//i.test(part)) return maskPlainText(part);
        try {
          const url = new URL(part);
          if (
            !repositories.some(
              (repo) =>
                url.origin === repo.origin &&
                (url.pathname === repo.pathname ||
                  url.pathname.startsWith(repo.pathname + '/')),
            )
          )
            return replacement;
          url.username = '';
          url.password = '';
          url.pathname = url.pathname.split('/').map(maskPlainText).join('/');
          for (const key of [...url.searchParams.keys()]) {
            const values = url.searchParams.getAll(key);
            url.searchParams.delete(key);
            for (const value of values)
              url.searchParams.append(
                maskPlainText(key),
                secretKeys.test(key) ? replacement : maskPlainText(value),
              );
          }
          url.hash = maskPlainText(url.hash);
          return url.toString();
        } catch {
          return replacement;
        }
      })
      .join('');
  }

  function sanitize(value: unknown): unknown {
    if (typeof value === 'string') return maskText(value);
    if (Array.isArray(value)) return value.map(sanitize);
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value).map(([key, child]) => {
        let result: unknown;
        if (bodyKeys.test(key)) result = summarize(child);
        else if ((secretKeys.test(key) || hostKeys.test(key)) && child !== null)
          result = replacement;
        else result = sanitize(child);
        return [maskText(key), result] as const;
      });
      // Do not silently lose fields when sensitive keys collapse to the same marker.
      if (new Set(entries.map(([key]) => key)).size !== entries.length)
        throw new Error('Redacted key collision');
      return Object.fromEntries(entries);
    }
    return value;
  }

  function hasLeaks(value: unknown): boolean {
    return JSON.stringify(sanitize(value)) !== JSON.stringify(value);
  }

  return { maskText, sanitize, summarize, hasLeaks };
}

export const { maskText, sanitize, hasLeaks } = createRedactor();

const uuid = /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/gi;
const inputFlags = new Set([
  '--body',
  '--prompt',
  '--spec',
  '--spec-file',
  '--question',
  '--objective',
]);
/** One instance per recording session preserves identities across response files. */
export class FixtureNormalizer {
  private readonly ids = new Map<string, string>();
  constructor(
    private readonly redactor = createRedactor({
      preservedRepoUrls: ['https://github.com/ClarkeYeh/ai-office-spike'],
    }),
  ) {}
  text(value: string): string {
    const normalized = value
      .replace(uuid, (id) => {
        if (/^00000000-0000-4000-8000-/.test(id)) return id;
        let mapped = this.ids.get(id);
        if (!mapped) {
          mapped = `00000000-0000-4000-8000-${(this.ids.size + 1).toString(16).padStart(12, '0')}`;
          this.ids.set(id, mapped);
        }
        return mapped;
      })
      .replace(/\/(?:Users|home)\/(?:<redacted>|[^/\s"<>]+)/g, '<home>')
      .replace(/[A-Z]:\\Users\\[^\\\s"<>]+/gi, '<home>');
    return this.redactor.maskText(normalized);
  }
  bind(actual: string, expected: string): void {
    const a = actual.match(uuid) ?? [];
    const b = expected.match(uuid) ?? [];
    if (a.length !== b.length) return;
    for (let i = 0; i < a.length; i++) {
      // Callers may use the already-normalized identity returned by replay.
      if (a[i] === b[i]) continue;
      const prior = this.ids.get(a[i]!);
      if (prior && prior !== b[i]) throw new Error('Replay identity mismatch');
      if (
        !prior &&
        [...this.ids.entries()].some(
          ([key, value]) => value === b[i] && key !== a[i],
        )
      )
        throw new Error('Replay identity alias');
      this.ids.set(a[i]!, b[i]!);
    }
  }
  argv(args: readonly string[]): string[] {
    return args.map((arg, i) =>
      inputFlags.has(args[i - 1] ?? '')
        ? '<redacted:test-input>'
        : this.text(arg),
    );
  }
  value(value: unknown): unknown {
    const walk = (item: unknown): unknown => {
      if (typeof item === 'string') return this.text(item);
      if (Array.isArray(item)) return item.map(walk);
      if (item && typeof item === 'object')
        return Object.fromEntries(
          Object.entries(item).map(([key, child]) => [
            key,
            /^(?:body|content|text|input|output|preview|spec|prompt|question|objective|stderrLines)$/i.test(
              key,
            ) &&
            (typeof child === 'string' || key === 'stderrLines')
              ? summarize(child)
              : /^(?:username|gitUsername|ownerName)$/i.test(key) &&
                  typeof child === 'string'
                ? '<redacted>'
                : key === 'projectId' && typeof child === 'string'
                  ? this.text(
                      child.replace(/^(github:)[^/]+\//, '$1<redacted>/'),
                    )
                  : key === 'argv' &&
                      Array.isArray(child) &&
                      child.every((arg) => typeof arg === 'string')
                    ? this.argv(child as string[])
                    : walk(child),
          ]),
        );
      return item;
    };
    return this.redactor.sanitize(walk(value));
  }
}
