import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bodyHash } from '@ai-office/domain';
import { createRedactor } from '@ai-office/redaction';
import { PortError } from '../../../ports/errors.js';
import { ScmCursorSchema, type ScmCursor } from '../../../ports/refs.js';
import { CREATE_PENDING_WINDOW_MS } from '../../../ports/scm.js';
import { ScmEventSchema, type ScmEvent } from '../../../ports/scm-events.js';
import { createGithubScm, RepoAllowlist } from '../index.js';
import { CURSOR_LIMITS, createPoller, rollupChecks } from './index.js';
import { emptyState, encodeCursor } from './cursor.js';
import {
  checkRunsSchema,
  combinedStatusSchema,
  commentListSchema,
  issueListSchema,
  pullListSchema,
  pullSchema,
} from './schemas.js';

const repo = { owner: 'ClarkeYeh', name: 'spike' };
const viewer = 'ClarkeYeh';
const sha = (seed: string) =>
  createHash('sha1').update(seed).digest('hex').slice(0, 40);
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const marker = (id: string) => `<!-- ai-office:cmd=${id} -->`;
type Issue = {
  number: number;
  user: { login: string };
  body: string | null;
  labels: { name: string }[];
  created_at: string;
  updated_at: string;
  pull_request?: object;
};
type Pull = {
  number: number;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged_at: string | null;
  merged: boolean;
  merged_by: { login: string } | null;
  merge_commit_sha: string | null;
  mergeable: boolean | null;
  updated_at: string;
};

/** A minimal GitHub that answers the poll's GET endpoints with strong ETags. */
class FakeGithub {
  time = Date.parse('2026-11-19T06:00:00Z');
  /** GitHub's real next links: `/repositories/{id}/…` plus an `after` cursor. */
  canonicalLinks = false;
  readonly repositoryId = 4242;
  issues = new Map<number, Issue>();
  pulls = new Map<number, Pull>();
  comments: {
    id: number;
    user: { login: string };
    body: string;
    issue_url: string;
    created_at: string;
    updated_at: string;
  }[] = [];
  refs = new Map<string, string>([['main', sha('main-0')]]);
  runs = new Map<string, { status: string; conclusion: string | null }[]>();
  statuses = new Map<string, { state: string }[]>();
  log: {
    method: string;
    path: string;
    status: number;
    ifNoneMatch?: string;
  }[] = [];
  private sequence = 0;
  private commentSequence = 7_000_000_000;
  tick(ms = 1000) {
    this.time += ms;
    return iso(this.time);
  }
  issue(body: string | null, author = viewer, pr = false) {
    const at = this.tick();
    const number = ++this.sequence;
    this.issues.set(number, {
      number,
      user: { login: author },
      body,
      labels: [],
      created_at: at,
      updated_at: at,
      ...(pr ? { pull_request: {} } : {}),
    });
    return number;
  }
  touch(number: number, patch: Partial<Issue>) {
    Object.assign(this.issues.get(number)!, patch, { updated_at: this.tick() });
  }
  pull(head: string, base: string, mergeable: boolean | null = null) {
    const number = this.issue(marker(`pr-${head}`), viewer, true);
    this.refs.set(head, this.refs.get(head) ?? sha(head));
    this.pulls.set(number, {
      number,
      state: 'open',
      head: { ref: head, sha: this.refs.get(head)! },
      base: { ref: base, sha: this.refs.get(base) ?? sha(base) },
      merged_at: null,
      merged: false,
      merged_by: null,
      merge_commit_sha: null,
      mergeable,
      updated_at: iso(this.time),
    });
    return number;
  }
  updatePull(number: number, patch: Partial<Pull>) {
    Object.assign(this.pulls.get(number)!, patch, { updated_at: this.tick() });
    this.touch(number, {});
  }
  comment(target: number, body: string, author = viewer) {
    const at = this.tick();
    const id = ++this.commentSequence;
    this.comments.push({
      id,
      user: { login: author },
      body,
      issue_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${target}`,
      created_at: at,
      updated_at: at,
    });
    return String(id);
  }
  private page<T>(items: T[], url: URL) {
    const size = Number(url.searchParams.get('per_page') ?? 30);
    const page = Number(url.searchParams.get('page') ?? 1);
    const slice = items.slice((page - 1) * size, page * size);
    if (page * size >= items.length) return { data: slice };
    const next = new URL(url);
    next.searchParams.set('page', String(page + 1));
    if (this.canonicalLinks) {
      next.pathname = next.pathname.replace(
        `/repos/${repo.owner}/${repo.name}`,
        `/repositories/${this.repositoryId}`,
      );
      next.searchParams.set(
        'after',
        Buffer.from(`cursor:${page * size}`).toString('base64'),
      );
    }
    return { data: slice, link: `<${next.href}>; rel="next"` };
  }
  private route(url: URL): { data: unknown; link?: string } | undefined {
    const root = `/repos/${repo.owner}/${repo.name}`;
    const path = decodeURIComponent(url.pathname);
    const since = url.searchParams.get('since');
    const recent = <T extends { updated_at: string }>(items: T[]) =>
      items
        .filter((i) => !since || Date.parse(i.updated_at) >= Date.parse(since))
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    if (path === root)
      return { data: { id: this.repositoryId, default_branch: 'main' } };
    if (path === `${root}/issues`)
      return this.page(recent([...this.issues.values()]), url);
    if (path === `${root}/issues/comments`)
      return this.page(recent(this.comments), url);
    if (path === `${root}/pulls`)
      return this.page(
        // The list omits mergeable and merged_by, like GitHub's.
        recent([...this.pulls.values()]).map((pr) => {
          const summary: Partial<Pull> = { ...pr };
          delete summary.mergeable;
          delete summary.merged;
          delete summary.merged_by;
          return summary;
        }),
        url,
      );
    const pull = new RegExp(`^${root}/pulls/(\\d+)$`).exec(path);
    if (pull) return { data: this.pulls.get(Number(pull[1])) };
    if (path === `${root}/git/matching-refs/heads/ai-office/`)
      return this.page(
        [...this.refs]
          .filter(([b]) => b.startsWith('ai-office/'))
          .map(([b, s]) => ({ ref: `refs/heads/${b}`, object: { sha: s } })),
        url,
      );
    const ref = new RegExp(`^${root}/git/ref/heads/(.+)$`).exec(path);
    if (ref && this.refs.has(ref[1]!))
      return {
        data: {
          ref: `refs/heads/${ref[1]}`,
          object: { sha: this.refs.get(ref[1]!) },
        },
      };
    const runs = new RegExp(`^${root}/commits/(\\w+)/check-runs$`).exec(path);
    if (runs) {
      const list = this.runs.get(runs[1]!) ?? [];
      return { data: { total_count: list.length, check_runs: list } };
    }
    const status = new RegExp(`^${root}/commits/(\\w+)/status$`).exec(path);
    if (status) {
      const list = this.statuses.get(status[1]!) ?? [];
      // G7: combined state is "pending" when there are no statuses at all.
      const state = list.some((s) => s.state !== 'success')
        ? 'pending'
        : list.length
          ? 'success'
          : 'pending';
      return { data: { state, statuses: list, total_count: list.length } };
    }
    return undefined;
  }
  fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const ifNoneMatch = new Headers(init?.headers).get('if-none-match');
    const found = method === 'GET' ? this.route(url) : undefined;
    const entry = {
      method,
      path: `${url.pathname}${url.search}`,
      status: found ? 200 : 404,
      ...(ifNoneMatch ? { ifNoneMatch } : {}),
    };
    this.log.push(entry);
    if (!found)
      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
      });
    const text = JSON.stringify(found.data);
    const etag = `"${createHash('sha256').update(text).digest('hex')}"`;
    const headers: Record<string, string> = { etag };
    if (found.link) headers.link = found.link;
    if (ifNoneMatch === etag) {
      entry.status = 304;
      return new Response(null, { status: 304, headers });
    }
    return new Response(text, { status: 200, headers });
  };
}

const redactor = createRedactor();
function setup(github = new FakeGithub()) {
  const connect = () => {
    const base = createGithubScm({
      fetch: github.fetch,
      clock: { now: () => new Date(github.time) },
      sleep: async () => {},
      tokenProvider: async () => 'test-credential',
      repoAllowlist: new RepoAllowlist([repo]),
      maskSecrets: <T>(value: T): T => redactor.maskText(String(value)) as T,
    });
    return createPoller({
      http: base.http,
      clock: () => github.time,
      viewerLogin: async () => viewer,
      defaultBranch: async () => 'main',
    });
  };
  let poller = connect();
  const poll = async (cursor: ScmCursor | null) => {
    const result = await poller.poll(repo, cursor);
    for (const event of result.events)
      expect(ScmEventSchema.safeParse(event).success).toBe(true);
    return result;
  };
  return {
    github,
    poll,
    /** A backend restart: same GitHub, empty HTTP cache. */
    restart: () => {
      poller = connect();
    },
  };
}
const ofType = <T extends ScmEvent['type']>(events: ScmEvent[], type: T) =>
  events.filter((e): e is Extract<ScmEvent, { type: T }> => e.type === type);

describe('scm-github poll transition keys survive a return to an earlier state (FX-C)', () => {
  const keys = (events: ScmEvent[]) => events.map((e) => e.externalKey);
  it('reopened PR: open → closed → open get three distinct keys; a replayed cursor repeats them', async () => {
    const { github, poll } = setup();
    let cursor = (await poll(null)).cursor;
    const pr = github.pull('ai-office/abc-int', 'main', true);
    const seen: string[] = [];
    const step = async () => {
      const before = cursor;
      const result = await poll(before);
      cursor = result.cursor;
      const states = ofType(result.events, 'pr.state').filter(
        (e) => e.pr.number === pr,
      );
      seen.push(...keys(states));
      // Replaying the uncommitted cursor yields the same keys.
      expect(keys(ofType((await poll(before)).events, 'pr.state'))).toEqual(
        keys(ofType(result.events, 'pr.state')),
      );
      return states;
    };
    expect((await step()).map((e) => e.state)).toEqual(['open']);
    github.updatePull(pr, { state: 'closed' });
    expect((await step()).map((e) => e.state)).toEqual(['closed']);
    github.updatePull(pr, { state: 'open' });
    expect((await step()).map((e) => e.state)).toEqual(['open']);
    expect(new Set(seen).size).toBe(3);
  });
  it('body edited, reverted and edited again: every edit has a fresh key', async () => {
    const { github, poll } = setup();
    let cursor = (await poll(null)).cursor;
    const issue = github.issue(`Original\n${marker('c1')}`);
    cursor = (await poll(cursor)).cursor;
    const seen: string[] = [];
    for (const body of ['Edited', 'Original', 'Edited']) {
      github.touch(issue, { body: `${body}\n${marker('c1')}` });
      const result = await poll(cursor);
      cursor = result.cursor;
      const edits = ofType(result.events, 'issue.edited');
      expect(edits.map((e) => e.bodyHash)).toEqual([
        bodyHash(`${body}\n${marker('c1')}`),
      ]);
      seen.push(...keys(edits));
    }
    expect(new Set(seen).size).toBe(3);
  });
  it('branch moved A → B → A: every move has a fresh key', async () => {
    const { github, poll } = setup();
    github.refs.set('ai-office/abc-int', sha('A'));
    let cursor = (await poll(null)).cursor;
    const seen: string[] = [];
    for (const seed of ['B', 'A', 'B']) {
      github.refs.set('ai-office/abc-int', sha(seed));
      const result = await poll(cursor);
      cursor = result.cursor;
      const moves = ofType(result.events, 'branch.head_changed').filter(
        (e) => e.branch === 'ai-office/abc-int',
      );
      expect(moves.map((e) => e.sha)).toEqual([sha(seed)]);
      seen.push(...keys(moves));
    }
    expect(new Set(seen).size).toBe(3);
  });
  it('checks flapping none ↔ pending: every change has a fresh key', async () => {
    const { github, poll } = setup();
    const pr = github.pull('ai-office/abc-int', 'main', true);
    const head = github.pulls.get(pr)!.head.sha;
    let cursor = (await poll(null)).cursor;
    cursor = (await poll(cursor)).cursor;
    const seen: string[] = [];
    for (const pending of [true, false, true]) {
      github.runs.set(
        head,
        pending ? [{ status: 'in_progress', conclusion: null }] : [],
      );
      github.touch(pr, {});
      const result = await poll(cursor);
      cursor = result.cursor;
      const checks = ofType(result.events, 'pr.checks');
      expect(checks.map((e) => e.status)).toEqual([
        pending ? 'pending' : 'none',
      ]);
      seen.push(...keys(checks));
    }
    expect(new Set(seen).size).toBe(3);
  });
  it('accepts a cursor written before FX-C and starts its chains', async () => {
    const { github, poll } = setup();
    const pr = github.pull('ai-office/abc-int', 'main', true);
    const first = await poll(null);
    const legacy = JSON.parse(first.cursor) as Record<string, unknown>;
    delete legacy.k;
    github.updatePull(pr, { state: 'closed' });
    const next = await poll(ScmCursorSchema.parse(JSON.stringify(legacy)));
    expect(ofType(next.events, 'pr.state').map((e) => e.state)).toEqual([
      'closed',
    ]);
    expect(JSON.parse(next.cursor).k[`pr:${pr}`]).toBe(
      ofType(next.events, 'pr.state')[0]!.externalKey,
    );
  });
  it('sheds chain keys rather than failing when a full cursor exceeds the byte limit', () => {
    // Every map at capacity with long (valid) branch names: without the chain
    // keys this fits, so the chains must never make the cursor unencodable.
    const state = emptyState(repo, 'main');
    const branch = (i: number) =>
      `ai-office/${String(i).padStart(4, '0')}/`.padEnd(200, 'x');
    const suffix = 'f'.repeat(16);
    state.k = {};
    for (let i = 0; i < CURSOR_LIMITS.refs; i++) {
      state.refs[branch(i)] = sha(`r${i}`);
      state.k[`ref:${branch(i)}`] =
        `gh:ref:${branch(i)}:${sha(`r${i}`)}:${suffix}`;
    }
    for (let i = 1; i <= CURSOR_LIMITS.prs; i++) {
      state.prs[i] = { s: 'open', h: sha(`h${i}`), b: branch(i), m: true };
      state.ck[i] = 'pending';
      state.k[`pr:${i}`] =
        `gh:pr:${i}:open:${sha(`h${i}`)}:true:${branch(i)}:${suffix}`;
      state.k[`ck:${i}`] = `gh:checks:${i}:${sha(`h${i}`)}:pending:${suffix}`;
    }
    for (let i = 1000; i < 1000 + CURSOR_LIMITS.issues; i++) {
      state.is[i] = ['a'.repeat(16), 'b'.repeat(16)];
      state.k[`issue:${i}`] = `gh:issue:${i}:${'c'.repeat(64)}:${suffix}`;
    }
    const cursor = encodeCursor(state);
    expect(cursor.length).toBeLessThanOrEqual(CURSOR_LIMITS.bytes);
    const decoded = JSON.parse(cursor);
    expect(Object.keys(decoded.refs)).toHaveLength(CURSOR_LIMITS.refs);
    expect(Object.keys(decoded.prs)).toHaveLength(CURSOR_LIMITS.prs);
    expect(Object.keys(decoded.k).length).toBeLessThan(
      Object.keys(state.k).length,
    );
  });
  it('keeps one chain key per tracked object', () => {
    const state = emptyState(repo, 'main');
    state.prs = { 7: { s: 'open', h: sha('h'), b: 'main', m: true } };
    state.refs = { main: sha('m') };
    state.is = { 9: ['a', 'b'] };
    state.k = {
      'pr:7': 'kept-pr',
      'ck:7': 'kept-checks',
      'ref:main': 'kept-ref',
      'issue:9': 'kept-issue',
      'pr:8': 'dropped',
      'issue:10': 'dropped',
      'ref:ai-office/gone': 'dropped',
    };
    expect(JSON.parse(encodeCursor(state)).k).toEqual({
      'pr:7': 'kept-pr',
      'ck:7': 'kept-checks',
      'ref:main': 'kept-ref',
      'issue:9': 'kept-issue',
    });
  });
});

describe('scm-github poll', () => {
  it('carries the body hash on first sighting, including an edit made before it (FX-B)', async () => {
    const { github, poll } = setup();
    const first = await poll(null);
    const issue = github.issue(`Conclusion\n${marker('c1')}`);
    const edited = `Conclusion, edited at once\n${marker('c1')}`;
    github.touch(issue, { body: edited });
    const pr = github.pull('ai-office/abc-int', 'main');
    const seen = await poll(first.cursor);
    const created = ofType(seen.events, 'repo.object_created');
    expect(created.find((e) => e.ref.number === issue)).toMatchObject({
      bodyHash: bodyHash(edited),
      updatedAt: github.issues.get(issue)!.updated_at,
    });
    expect(created.find((e) => e.ref.number === pr)).not.toHaveProperty(
      'bodyHash',
    );
    expect(ofType(seen.events, 'issue.edited')).toEqual([]);
  });
  it("follows GitHub's canonical cursor links past 100 Issues (M3-T15 live finding)", async () => {
    const github = new FakeGithub();
    github.canonicalLinks = true;
    for (let i = 0; i < 120; i++) github.issue(`Old ${i}`, 'someone-else');
    const { poll } = setup(github);
    const first = await poll(null);
    const conclusion = github.issue(`Conclusion\n${marker('c1')}`);
    // More than one page changed since the watermark.
    for (let i = 1; i <= 110; i++) github.touch(i, {});
    const seen = await poll(first.cursor);
    expect(
      ofType(seen.events, 'repo.object_created').map((e) => e.ref.number),
    ).toContain(conclusion);
    github.touch(conclusion, { body: `Edited\n${marker('c1')}` });
    const next = await poll(seen.cursor);
    expect(
      ofType(next.events, 'issue.edited').map((e) => e.issue.number),
    ).toEqual([conclusion]);
    // Later pages were re-requested on the authorized path with the cursor.
    const root = `/repos/${repo.owner}/${repo.name}`;
    expect(
      github.log.some(
        (r) =>
          r.path.startsWith(`${root}/issues?`) && r.path.includes('after='),
      ),
    ).toBe(true);
    expect(github.log.some((r) => r.path.startsWith('/repositories/'))).toBe(
      false,
    );
  });
  it('is idle after the baseline: every request 304 and no events', async () => {
    const { github, poll } = setup();
    github.issue(`Conclusion\n${marker('c1')}`);
    github.pull('ai-office/abc-int', 'main', true);
    const first = await poll(null);
    expect(ofType(first.events, 'branch.head_changed')).toContainEqual(
      expect.objectContaining({ branch: 'main', previousSha: null }),
    );
    // The first watermarked list URL differs from the baseline's unfiltered one.
    const settled = await poll(first.cursor);
    expect(settled.events).toEqual([]);
    github.log.length = 0;
    const idle = await poll(settled.cursor);
    expect(idle.events).toEqual([]);
    expect(github.log.length).toBeGreaterThan(0);
    expect(github.log.every((r) => r.status === 304)).toBe(true);
    expect(github.log.every((r) => r.method === 'GET')).toBe(true);
    // Steady state stays small (§4.4: about four requests plus open-PR checks).
    expect(github.log.length).toBeLessThanOrEqual(8);
  });
  it('replays an uncommitted cursor with the same events, then nothing', async () => {
    const { github, poll } = setup();
    const initial = await poll(null);
    const number = github.issue(`New ${marker('new')}`);
    github.refs.set('ai-office/abc-int', sha('int-1'));
    const created = await poll(initial.cursor);
    expect(created.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'repo.object_created',
          ref: { repo, number },
          hasMarker: true,
          author: viewer,
        }),
        expect.objectContaining({
          type: 'branch.head_changed',
          branch: 'ai-office/abc-int',
          previousSha: null,
        }),
      ]),
    );
    expect(await poll(initial.cursor)).toEqual(created);
    expect((await poll(created.cursor)).events).toEqual([]);
  });
  it('sends a cursor ETag only while cached: a restart re-reads unconditionally', async () => {
    const { github, poll, restart } = setup();
    github.issue('Body');
    const first = await poll(null);
    restart();
    github.log.length = 0;
    const after = await poll(first.cursor);
    expect(after.events).toEqual([]);
    expect(github.log.some((r) => r.ifNoneMatch)).toBe(false);
    github.log.length = 0;
    expect((await poll(after.cursor)).events).toEqual([]);
    expect(github.log.every((r) => r.status === 304)).toBe(true);
  });
  it('reports mergeable only once it turns from null into a boolean', async () => {
    const { github, poll } = setup();
    const pr = github.pull('ai-office/abc-w1', 'ai-office/abc-int', null);
    const first = await poll(null);
    expect(ofType(first.events, 'pr.state')).toEqual([
      expect.objectContaining({ pr: { repo, number: pr }, mergeable: null }),
    ]);
    const still = await poll(first.cursor);
    expect(ofType(still.events, 'pr.state')).toEqual([]);
    github.pulls.get(pr)!.mergeable = true; // GitHub computes it without updated_at
    const ready = await poll(still.cursor);
    expect(ofType(ready.events, 'pr.state')).toEqual([
      expect.objectContaining({
        state: 'open',
        mergeable: true,
        base: 'ai-office/abc-int',
        head: 'ai-office/abc-w1',
      }),
    ]);
    expect(ofType((await poll(ready.cursor)).events, 'pr.state')).toEqual([]);
  });
  it('detects the owner hand-merging the final PR (§4.5) and records old terminal PRs silently', async () => {
    const { github, poll } = setup();
    const old = github.pull('ai-office/old-int', 'main');
    github.updatePull(old, {
      state: 'closed',
      merged_at: iso(github.time),
      merged: true,
    });
    const final = github.pull('ai-office/abc-int', 'main', true);
    const before = await poll(null);
    expect(ofType(before.events, 'pr.state').map((e) => e.pr.number)).toEqual([
      final,
    ]);
    const merge = sha('merge');
    github.updatePull(final, {
      state: 'closed',
      merged: true,
      merged_at: iso(github.time),
      merged_by: { login: viewer },
      merge_commit_sha: merge,
      mergeable: null,
    });
    github.refs.set('main', merge);
    const after = await poll(before.cursor);
    expect(ofType(after.events, 'pr.state')).toEqual([
      expect.objectContaining({
        pr: { repo, number: final },
        state: 'merged',
        mergedBy: viewer,
        mergeCommitSha: merge,
        base: 'main',
      }),
    ]);
    expect(ofType(after.events, 'branch.head_changed')).toEqual([
      expect.objectContaining({
        branch: 'main',
        sha: merge,
        previousSha: sha('main-0'),
      }),
    ]);
  });
  it('reports external closes, head pushes and retargets of PRs', async () => {
    const { github, poll } = setup();
    const pr = github.pull('ai-office/abc-w1', 'ai-office/abc-int', true);
    const first = await poll(null);
    github.refs.set('ai-office/abc-w1', sha('w1-2'));
    github.updatePull(pr, {
      head: { ref: 'ai-office/abc-w1', sha: sha('w1-2') },
    });
    const pushed = await poll(first.cursor);
    expect(ofType(pushed.events, 'pr.state')).toEqual([
      expect.objectContaining({ headSha: sha('w1-2') }),
    ]);
    expect(ofType(pushed.events, 'branch.head_changed')).toEqual([
      expect.objectContaining({
        branch: 'ai-office/abc-w1',
        sha: sha('w1-2'),
        previousSha: sha('ai-office/abc-w1'),
      }),
    ]);
    github.updatePull(pr, { base: { ref: 'main', sha: sha('main-0') } });
    const retargeted = await poll(pushed.cursor);
    expect(ofType(retargeted.events, 'pr.state')).toEqual([
      expect.objectContaining({ base: 'main' }),
    ]);
    github.updatePull(pr, { state: 'closed', mergeable: null });
    const closed = await poll(retargeted.cursor);
    expect(ofType(closed.events, 'pr.state')).toEqual([
      expect.objectContaining({ state: 'closed', mergeable: null }),
    ]);
  });
  it('ignores PRs whose head is not an ai-office/ branch', async () => {
    const { github, poll } = setup();
    github.pull('feature/spike-gh', 'main', true);
    const first = await poll(null);
    expect(ofType(first.events, 'pr.state')).toEqual([]);
    expect(ofType(first.events, 'pr.checks')).toEqual([]);
  });
  it('reports unmarked Issues, label changes and body edits by hash', async () => {
    const { github, poll } = setup();
    const conclusion = github.issue(`Line\n${marker('c')}`);
    const first = await poll(null);
    const manual = github.issue('Filed by hand', 'someone-else');
    const created = await poll(first.cursor);
    expect(ofType(created.events, 'repo.object_created')).toEqual([
      expect.objectContaining({
        ref: { repo, number: manual },
        hasMarker: false,
        author: 'someone-else',
      }),
    ]);
    github.touch(conclusion, { labels: [{ name: 'ai-office:pending' }] });
    github.comment(conclusion, 'A comment changes nothing');
    const labelled = await poll(created.cursor);
    expect(ofType(labelled.events, 'issue.edited')).toEqual([
      expect.objectContaining({
        issue: { repo, number: conclusion },
        bodyHash: bodyHash(`Line\n${marker('c')}`),
        labels: ['ai-office:pending'],
      }),
    ]);
    github.touch(conclusion, { body: `Line\r\n${marker('c')}` });
    expect(
      ofType((await poll(labelled.cursor)).events, 'issue.edited'),
    ).toEqual([]);
    github.touch(conclusion, { body: 'Edited on GitHub' });
    const edited = await poll(labelled.cursor);
    expect(ofType(edited.events, 'issue.edited')).toEqual([
      expect.objectContaining({ bodyHash: bodyHash('Edited on GitHub') }),
    ]);
  });
  it('reports duplicate Issue markers only past the pending window, once', async () => {
    const { github, poll } = setup();
    const before = await poll(null);
    const first = github.issue(`Item ${marker('twice')}`);
    github.tick(CREATE_PENDING_WINDOW_MS + 1000);
    const second = github.issue(`Item ${marker('twice')}`);
    github.issue(`Quoted ${marker('twice')}`, 'someone-else');
    const early = await poll(before.cursor);
    expect(ofType(early.events, 'object.duplicate')).toEqual([]);
    github.tick(CREATE_PENDING_WINDOW_MS);
    const settled = await poll(early.cursor);
    expect(ofType(settled.events, 'object.duplicate')).toEqual([
      expect.objectContaining({
        commandId: 'twice',
        kind: 'issue',
        numbers: [first, second],
      }),
    ]);
    expect(
      ofType((await poll(settled.cursor)).events, 'object.duplicate'),
    ).toEqual([]);
  });
  it('reports duplicate comment markers with target and comment ids', async () => {
    const { github, poll } = setup();
    const target = github.issue(`Conclusion ${marker('c')}`);
    const before = await poll(null);
    const a = github.comment(target, `Decision ${marker('note')}`);
    const b = github.comment(target, `Decision ${marker('note')}`);
    github.tick(CREATE_PENDING_WINDOW_MS);
    const polled = await poll(before.cursor);
    expect(ofType(polled.events, 'object.duplicate')).toEqual([
      expect.objectContaining({
        commandId: 'note',
        kind: 'comment',
        target: { repo, number: target },
        commentIds: [a, b],
      }),
    ]);
  });
  it('rolls up checks per head and stops querying a terminal head', async () => {
    const { github, poll } = setup();
    const pr = github.pull('ai-office/abc-w1', 'ai-office/abc-int', true);
    const head = sha('ai-office/abc-w1');
    const first = await poll(null);
    expect(ofType(first.events, 'pr.checks')).toEqual([
      expect.objectContaining({ pr: { repo, number: pr }, status: 'none' }),
    ]);
    github.statuses.set(head, [{ state: 'pending' }]);
    github.runs.set(head, [{ status: 'completed', conclusion: 'success' }]);
    const pending = await poll(first.cursor);
    expect(ofType(pending.events, 'pr.checks')).toEqual([
      expect.objectContaining({ status: 'pending' }),
    ]);
    github.statuses.set(head, [{ state: 'success' }]);
    const done = await poll(pending.cursor);
    expect(ofType(done.events, 'pr.checks')).toEqual([
      expect.objectContaining({ status: 'success' }),
    ]);
    github.log.length = 0;
    expect((await poll(done.cursor)).events).toEqual([]);
    expect(github.log.some((r) => r.path.includes(head))).toBe(false);
  });
  it('rejects malformed cursors and cursors of another repository', async () => {
    const { poll } = setup();
    for (const cursor of ['owner/name:3', '{}', JSON.stringify({ v: 2 })])
      await expect(poll(ScmCursorSchema.parse(cursor))).rejects.toMatchObject({
        category: 'validation',
        code: 'invalid_cursor',
      });
    const other = encodeCursor(emptyState({ owner: 'x', name: 'y' }, 'main'));
    await expect(poll(other)).rejects.toBeInstanceOf(PortError);
  });
  it('bounds the cursor', () => {
    const state = emptyState(repo, 'main');
    for (let n = 1; n <= 3000; n++)
      state.is[n] = ['0123456789abcdef', 'fedcba9876543210'];
    for (let n = 1; n <= 900; n++)
      state.mk[`issue:cmd-${n}`] = { n: [n], t: n };
    const cursor = encodeCursor(state);
    expect(cursor.length).toBeLessThanOrEqual(CURSOR_LIMITS.bytes);
    const decoded = JSON.parse(cursor) as typeof state;
    expect(Object.keys(decoded.is)).toHaveLength(CURSOR_LIMITS.issues);
    expect(decoded.is[3000]).toBeDefined();
    expect(Object.keys(decoded.mk)).toHaveLength(CURSOR_LIMITS.markers);
    expect(decoded.mk['issue:cmd-900']).toBeDefined();
  });
  it('pages Issue lists past 100 updates', async () => {
    const { github, poll } = setup();
    const before = await poll(null);
    for (let n = 0; n < 130; n++) github.issue(`Item ${n}`);
    const polled = await poll(before.cursor);
    expect(ofType(polled.events, 'repo.object_created')).toHaveLength(130);
  });
});

describe('scm-github poll schemas against T1 recordings', () => {
  const fixture = (file: string) =>
    z
      .looseObject({ response: z.unknown() })
      .parse(
        JSON.parse(
          readFileSync(
            new URL(
              `../../../../../../fixtures/github/2022-11-28/${file}`,
              import.meta.url,
            ),
            'utf8',
          ),
        ),
      ).response;
  it('parses recorded lists and PRs', () => {
    expect(
      issueListSchema.parse(fixture('g2-etag.list-issues-200.json')),
    ).toHaveLength(4);
    expect(
      commentListSchema.parse(fixture('g6-visibility.list-comments.json'))
        .length,
    ).toBeGreaterThan(0);
    expect(
      pullListSchema.parse(fixture('g6-visibility.list-pulls.json'))[0]!.head
        .ref,
    ).toMatch(/^ai-office\//);
    expect(
      pullSchema.parse(fixture('g4-merge.get-pr-merged.json')),
    ).toMatchObject({
      merged: true,
      merged_by: { login: viewer },
      mergeable: null,
    });
    expect(
      pullSchema.parse(fixture('g3-mergeable.get-pr-unknown.json')).mergeable,
    ).toBeNull();
  });
  it.each([
    ['g7-checks.check-runs-empty.json', 'g7-checks.status-empty.json', 'none'],
    [
      'g7-checks.check-runs-empty.json',
      'g7-checks.status-pending.json',
      'pending',
    ],
    [
      'g7-checks.check-runs-empty.json',
      'g7-checks.status-success.json',
      'success',
    ],
    [
      'g7-checks.check-runs-actions-queued.json',
      'g7-checks.status-actions-only.json',
      'pending',
    ],
    [
      'g7-checks.check-runs-actions-completed.json',
      'g7-checks.status-actions-only.json',
      'success',
    ],
  ])('rolls up %s with %s as %s', (runs, status, expected) => {
    expect(
      rollupChecks(
        checkRunsSchema.parse(fixture(runs)),
        combinedStatusSchema.parse(fixture(status)),
      ),
    ).toBe(expected);
  });
  it('treats any failed run or status as failure', () => {
    expect(
      rollupChecks(
        {
          total_count: 1,
          check_runs: [{ status: 'completed', conclusion: 'timed_out' }],
        },
        { state: 'success', statuses: [{ state: 'success' }] },
      ),
    ).toBe('failure');
    expect(
      rollupChecks(
        { total_count: 0, check_runs: [] },
        { state: 'failure', statuses: [{ state: 'error' }] },
      ),
    ).toBe('failure');
  });
});
