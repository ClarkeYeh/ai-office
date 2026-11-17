import { createHash } from 'node:crypto';

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
const patterns = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  /[a-z][a-z0-9+.-]*:\/\/[^/\s"<>]+/gi,
  /\b(?:gh[a-z]_+[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|aio_seat_[A-Za-z0-9_-]+)/g,
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
      for (const pattern of patterns) {
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

// Only the dedicated test repository is public fixture provenance. URL parsing
// prevents prefix lookalikes, userinfo and query credentials from bypassing masking.
export function maskText(value: string): string {
  return value
    .split(/(https?:\/\/[^\s"'<>]+)/gi)
    .map((part) => {
      if (!/^https?:\/\//i.test(part)) return maskPlainText(part);
      try {
        const url = new URL(part);
        if (
          url.origin !== 'https://github.com' ||
          !/^\/ClarkeYeh\/ai-office-spike(?:\/|$)/.test(url.pathname)
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

export function summarize(value: unknown): string {
  if (typeof value === 'string' && summaryPattern.test(value)) return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `<redacted length=${Buffer.byteLength(text, 'utf8')} sha256=${createHash('sha256').update(text).digest('hex')}>`;
}

export function sanitize(value: unknown): unknown {
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

export function hasLeaks(value: unknown): boolean {
  return JSON.stringify(sanitize(value)) !== JSON.stringify(value);
}
