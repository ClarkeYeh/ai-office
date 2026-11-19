import { createRedactor } from '@ai-office/redaction';
import { API, ROOT, REPO } from './safety.js';

const htmlRoot = `https://github.com/${REPO}`;
const redactor = createRedactor({ preservedRepoUrls: [htmlRoot] });

/** Per-tape identities; normalization is idempotent and never changes request hashes. */
export class TapeNormalizer {
  private readonly nodes = new Map<string, string>();
  value<T>(value: T): T {
    const walk = (v: unknown, key = ''): unknown => {
      if (typeof v === 'string') {
        // Opaque text must be hashed unchanged so known request bodies rehydrate.
        if (
          /^(?:body|content|text|input|output|preview|spec|prompt|question|objective|stderrLines)$/i.test(
            key,
          )
        )
          return v;
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
              throw new Error('Unsafe tape URL');
            // Valid, fixture-safe URLs; adapter requests retain their original API paths.
            return (
              htmlRoot +
              '/__api__' +
              url.pathname.slice(ROOT.length) +
              url.search +
              url.hash
            );
          }
          if (url.hostname === 'avatars.githubusercontent.com') {
            assertNoSensitiveText(v);
            if (url.username || url.password)
              throw new Error('Unsafe tape URL');
            return htmlRoot + '/__fixtures__/avatar.png';
          }
        }
        return v;
      }
      if (Array.isArray(v)) return v.map((x) => walk(x));
      if (v && typeof v === 'object')
        return Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k, walk(x, k)]),
        );
      return v;
    };
    return walk(value) as T;
  }
}

function assertNoSensitiveText(value: string): void {
  const text = decodeURIComponent(value);
  if (
    /\b(?:gh[a-z]_+[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|aio_seat_[A-Za-z0-9_-]+)|\/(?:Users|home)\/|[A-Z]:\\Users\\|PRIVATE KEY/i.test(
      text,
    )
  )
    throw new Error('Tape leak scan failed');
  for (const email of text.match(
    /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  ) ?? []) {
    if (!/@(?:example\.invalid|(?:users\.)?noreply\.github\.com)$/i.test(email))
      throw new Error('Tape leak scan failed');
  }
}

/** Check the complete normalized envelope, including structural request metadata. */
export function assertTapeSafe(value: unknown): void {
  assertNoSensitiveText(JSON.stringify(value));
  if (redactor.hasLeaks(value)) throw new Error('Tape leak scan failed');
}
