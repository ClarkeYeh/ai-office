import { githubRefRedactor } from './ref-redaction.js';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import {
  FixtureNormalizer,
  createRedactor,
  summarize,
} from '@ai-office/redaction';
import { API, ROOT, REPO } from './safety.js';
import {
  TapeLeakError,
  TapeNormalizer,
  assertTapeSafe,
} from './tape-normalization.js';

const API_ALIAS = `https://github.com/${REPO}/__api__`;
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
// Keep the raw response off enumerable Error fields and out of error reporters.
const leakedResponses = new WeakMap<TapeLeakError, Response>();
class RecordingLeak extends TapeLeakError {
  constructor(
    response: Response,
    readonly leak: TapeLeakError,
  ) {
    super();
    leakedResponses.set(this, response);
  }
}
export class RecordingFetch {
  readonly recordings: Recording[] = [];
  private readonly normalizer: GithubNormalizer;
  // Never let recording policy become a product transport error.
  // Incomplete tapes are refused at persistence after cleanup.
  private leak: TapeLeakError | undefined;
  withheldResponses = 0;
  constructor(
    private readonly transport: typeof fetch,
    runId?: string,
  ) {
    this.normalizer = new GithubNormalizer(runId);
  }
  fetch: typeof fetch = async (input, init) => {
    try {
      return await this.capture(input, init);
    } catch (error) {
      if (!(error instanceof RecordingLeak)) throw error;
      return leakedResponses.get(error)!;
    }
  };
  /** Harness-only boundary for wrappers that replace withheld rows themselves. */
  capture: typeof fetch = async (input, init) => {
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
    let headers: Record<string, string>, normalized: unknown;
    try {
      headers = this.normalizer.headers(response.headers);
      normalized = this.normalizer.value(data);
    } catch (error) {
      const leak = error instanceof TapeLeakError ? error : new TapeLeakError();
      this.leak ??= leak;
      this.withheldResponses++;
      // Only a fixed placeholder enters memory destined for persistence.
      this.recordings.push({
        apiVersion: '2022-11-28',
        ...sig,
        status: response.status,
        headers: {},
        response: { withheld: 'tape leak scan' },
      });
      throw new RecordingLeak(response, leak);
    }
    this.recordings.push({
      apiVersion: '2022-11-28',
      ...sig,
      status: response.status,
      headers,
      response: normalized,
    });
    return response;
  };
  /** For recorders that deliberately withhold a response after a leak. */
  acknowledge(error: unknown): void {
    if (error instanceof RecordingLeak && error.leak === this.leak) {
      this.leak = undefined;
      this.recordings.pop();
    }
  }
  assertNoLeak(): void {
    if (this.leak) throw this.leak;
  }
  async save(path: string): Promise<void> {
    this.assertNoLeak();
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
      if (summary)
        return (
          this.known.get(summary[1]!) ??
          `[recorded body ${summary[1]!.slice(0, 16)}]`
        );
      // TapeNormalizer stores spike API URLs as `<html root>/__api__…`; the
      // adapter parses some of them (a comment's issue_url), so restore them.
      const restored = value.startsWith(API_ALIAS)
        ? API + ROOT + value.slice(API_ALIAS.length)
        : value;
      return this.runId
        ? restored.replaceAll('000000000001', this.runId)
        : restored;
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
              ? value
                  .replace(/<\/repos\//g, '<' + API + '/repos/')
                  // A `/repositories/{id}/…` next link is redacted in the
                  // tape; replay it as the same-path form the client accepts.
                  .replace(/<<redacted>\?/g, '<' + API + sig.path + '?')
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
