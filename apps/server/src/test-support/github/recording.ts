import { githubRefRedactor } from './ref-redaction.js';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import {
  FixtureNormalizer,
  createRedactor,
  summarize,
} from '@ai-office/redaction';
import { API, ROOT, REPO } from './safety.js';
import { TapeNormalizer, assertTapeSafe } from './tape-normalization.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const redactor = githubRefRedactor(
  createRedactor({
    preservedRepoUrls: [`https://github.com/${REPO}`],
  }),
);
export interface Recording {
  apiVersion: '2022-11-28';
  method: string;
  pathTemplate: string;
  path: string;
  query: [string, string][];
  requestBodySha256: string;
  status: number;
  headers: Record<string, string>;
  response: unknown;
}
export class GithubNormalizer {
  private readonly normalizer = new FixtureNormalizer(redactor);
  private readonly tape = new TapeNormalizer();
  constructor(private readonly runId?: string) {}
  normalize(text: string): string {
    return this.runId ? text.replaceAll(this.runId, '000000000001') : text;
  }
  value(value: unknown): unknown {
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return this.normalize(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object')
        return Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k, walk(x)]),
        );
      return v;
    };
    return this.normalizer.value(this.tape.value(walk(value)));
  }
  headers(headers: Headers): Record<string, string> {
    return Object.fromEntries(
      [...headers]
        .filter(([k]) =>
          /^(etag|x-ratelimit-[a-z-]+|retry-after|link|x-github-request-id|date)$/.test(
            k,
          ),
        )
        .map(([k, v]) => [
          k,
          String(this.value(k === 'link' ? v.replaceAll(API, '') : v)),
        ]),
    );
  }
}
function pathTemplate(path: string): string {
  return path
    .replace(ROOT, '/repos/{owner}/{repo}')
    .replace(/\/(issues|pulls)\/\d+/g, '/$1/{number}')
    .replace(/\/comments\/\d+/g, '/comments/{id}')
    .replace(/\/(branches|compare|commits)\/.+$/, '/$1/{ref}')
    .replace(/\/git\/(ref|refs)\/heads\/.+$/, '/git/$1/heads/{ref}');
}
async function signature(request: Request, normalizer: GithubNormalizer) {
  const url = new URL(request.url);
  if (url.origin !== API) throw new Error('Recording origin not allowed');
  const path = normalizer.normalize(url.pathname);
  const text = normalizer.normalize(await request.clone().text());
  return {
    method: request.method,
    pathTemplate: pathTemplate(path),
    path,
    query: [...url.searchParams]
      .map(([k, v]): [string, string] => [k, normalizer.normalize(v)])
      .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv)),
    requestBodySha256: hash(text),
  };
}
export class RecordingFetch {
  readonly recordings: Recording[] = [];
  private readonly normalizer: GithubNormalizer;
  constructor(
    private readonly transport: typeof fetch,
    runId?: string,
  ) {
    this.normalizer = new GithubNormalizer(runId);
  }
  fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const sig = await signature(request, this.normalizer);
    const response = await this.transport(request);
    const text = await response.clone().text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = summarize(text);
      }
    }
    this.recordings.push({
      apiVersion: '2022-11-28',
      ...sig,
      status: response.status,
      headers: this.normalizer.headers(response.headers),
      response: this.normalizer.value(data),
    });
    return response;
  };
  async save(path: string): Promise<void> {
    // Request keys are structural metadata; sanitize them too before persistence.
    const value = new TapeNormalizer().value(this.recordings);
    assertTapeSafe(value);
    await writeFile(path, JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
}
export class ReplayFetch {
  private offset = 0;
  private readonly normalizer: GithubNormalizer;
  private readonly runId: string | undefined;
  private readonly known = new Map<string, string>();
  constructor(
    private readonly recordings: readonly Recording[],
    options: { runId?: string; bodies?: readonly string[] } = {},
  ) {
    this.normalizer = new GithubNormalizer(options.runId);
    this.runId = options.runId;
    for (const body of options.bodies ?? [])
      this.known.set(hash(this.normalizer.normalize(body)), body);
  }
  /** Known synthetic request values are available before their echoed response. */
  addKnownValues(value: unknown): void {
    if (typeof value === 'string')
      this.known.set(hash(this.normalizer.normalize(value)), value);
    else if (Array.isArray(value)) value.forEach((v) => this.addKnownValues(v));
    else if (value && typeof value === 'object')
      Object.values(value).forEach((v) => this.addKnownValues(v));
  }
  private rehydrate(value: unknown): unknown {
    if (typeof value === 'string') {
      const summary = /^<redacted length=\d+ sha256=([a-f0-9]{64})>$/.exec(
        value,
      );
      return summary
        ? (this.known.get(summary[1]!) ??
            `[recorded body ${summary[1]!.slice(0, 16)}]`)
        : this.runId
          ? value.replaceAll('000000000001', this.runId)
          : value;
    }
    if (Array.isArray(value)) return value.map((v) => this.rehydrate(v));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, this.rehydrate(v)]),
      );
    return value;
  }
  fetch: typeof fetch = async (input, init) => {
    const sig = await signature(new Request(input, init), this.normalizer);
    const next = this.recordings[this.offset];
    if (
      !next ||
      Object.entries(sig).some(
        ([key, value]) =>
          JSON.stringify(value) !==
          JSON.stringify(next[key as keyof Recording]),
      )
    )
      throw new Error('GitHub replay request mismatch');
    this.offset++;
    return new Response(
      [204, 205, 304].includes(next.status)
        ? null
        : JSON.stringify(this.rehydrate(next.response)),
      {
        status: next.status,
        headers: Object.fromEntries(
          Object.entries(next.headers).map(([key, value]) => [
            key,
            key === 'link'
              ? value.replace(/<\/repos\//g, '<' + API + '/repos/')
              : value,
          ]),
        ),
      },
    );
  };
  assertConsumed(): void {
    if (this.offset !== this.recordings.length)
      throw new Error('Unconsumed GitHub replay calls');
  }
}
