import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { bodyHash } from '@ai-office/domain';
import { CREATE_PENDING_WINDOW_MS } from '../../../ports/scm.js';
import type { RepoScmRef, ScmCursor } from '../../../ports/refs.js';
import type { ScmEvent } from '../../../ports/scm-events.js';
import type { EndpointId } from '../policy/endpoints.js';
import { nextQuery } from '../http/pagination.js';
import type { RequestParams } from '../http/types.js';
import { rollupChecks } from './checks.js';
import {
  decodeCursor,
  emptyState,
  encodeCursor,
  type PollState,
} from './cursor.js';
import type { ScmGithubDeps } from '../methods/deps.js';
import {
  checkRunsSchema,
  combinedStatusSchema,
  commentListSchema,
  issueListSchema,
  pullListSchema,
  pullSchema,
  refListSchema,
  refSchema,
} from './schemas.js';
export { CURSOR_LIMITS } from './cursor.js';
export { rollupChecks } from './checks.js';
export type { ScmGithubDeps } from '../methods/deps.js';
export type PollDeps = Pick<
  ScmGithubDeps,
  'http' | 'clock' | 'viewerLogin' | 'defaultBranch'
>;

/** List scans restart this far before the watermark (list lag p99 ≈ 9 s, G6). */
export const POLL_WATERMARK_SLACK_MS = 2 * 60_000;
const ISSUE_PAGES = 5;
const COMMENT_PAGES = 5;
const PULL_PAGES = 3;
const REF_PAGES = 3;
const PREFIX = 'ai-office/';
const markerPattern = /<!-- ai-office:cmd=([^\s<>]+) -->/g;
const short = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);
const later = (a: string | null, b: string) =>
  a === null || Date.parse(b) > Date.parse(a) ? b : a;
const commandIds = (body: string | null | undefined) => [
  ...new Set([...(body ?? '').matchAll(markerPattern)].map((m) => m[1]!)),
];
const labelNames = (labels: (string | { name: string })[]) =>
  labels.map((l) => (typeof l === 'string' ? l : l.name)).sort();
const issueNumber = (url: string) => {
  const match = /\/issues\/([1-9]\d*)$/.exec(url);
  return match ? Number(match[1]) : undefined;
};

/**
 * `poll` for scm-github (M3_PLAN §4.4, §4.5, §4.8). Read-only: duplicates are
 * reported as `object.duplicate`, cleanup is the engine's outbox commands.
 * Events are the diff between the cursor's state and GitHub's current state,
 * so replaying an uncommitted cursor yields the same events; ETags only make
 * unchanged reads free (a pinned ETag is sent while the HTTP cache holds it).
 */
export function createPoller(deps: PollDeps) {
  return {
    poll: (repo: RepoScmRef, cursor: ScmCursor | null) =>
      new Poll(deps, repo).run(cursor),
  };
}

class Poll {
  private prev!: PollState;
  private next!: PollState;
  private baseline = false;
  private now: string;
  constructor(
    private deps: PollDeps,
    private repo: RepoScmRef,
  ) {
    this.now = new Date(deps.clock()).toISOString();
  }
  async run(cursor: ScmCursor | null) {
    const defaultBranch = await this.deps.defaultBranch(this.repo);
    this.baseline = cursor === null;
    this.prev = cursor
      ? decodeCursor(cursor, this.repo)
      : emptyState(this.repo, defaultBranch);
    this.next = {
      ...structuredClone(this.prev),
      d: defaultBranch,
      e: {},
      ck: {},
    };
    const viewer = await this.deps.viewerLogin();
    const created: ScmEvent[] = [],
      edited: ScmEvent[] = [];
    await this.issues(viewer, created, edited);
    await this.comments(viewer);
    const prs = await this.pulls();
    const checks = await this.checks();
    const refs = await this.refs(defaultBranch);
    const events = [
      ...created,
      ...edited,
      ...prs,
      ...checks,
      ...refs,
      ...this.duplicates(),
    ];
    return { events, cursor: encodeCursor(this.next) };
  }
  private params(extra: RequestParams = {}): RequestParams {
    return { owner: this.repo.owner, repo: this.repo.name, ...extra };
  }
  /** One conditional read; the cursor keeps the ETag of what it diffed. */
  private async read<T>(
    id: EndpointId,
    key: string,
    params: RequestParams,
    schema: z.ZodType<T>,
  ) {
    const response = await this.deps.http.request(id, this.params(params), {
      schema,
      conditional: this.prev.e[key] ?? true,
    });
    if (response.etag) this.next.e[key] = response.etag;
    return response;
  }
  private async list<T>(
    id: EndpointId,
    query: Record<string, string | number>,
    schema: z.ZodType<T[]>,
    pages: number,
    more: (page: T[]) => boolean = () => true,
  ): Promise<T[]> {
    const items: T[] = [];
    let q: Record<string, string | number> = { ...query };
    for (let page = 1; page <= pages; page++) {
      const key = `${id}?${new URLSearchParams(
        Object.entries(q)
          .map(([k, v]): [string, string] => [k, String(v)])
          .sort(([a], [b]) => a.localeCompare(b)),
      )}`;
      const response = await this.read(id, key, { query: q }, schema);
      items.push(...response.data);
      if (response.next === undefined || !more(response.data)) break;
      // GitHub's validated next link: page number and, for cursor lists, `after`.
      q = { ...query };
      for (const [key, value] of Object.entries(nextQuery(response.next)))
        if (value !== undefined) q[key] = value;
    }
    return items;
  }
  private since(watermark: string | null) {
    return watermark === null
      ? {}
      : {
          since: new Date(Date.parse(watermark) - POLL_WATERMARK_SLACK_MS)
            .toISOString()
            .replace(/\.\d{3}Z$/, 'Z'),
        };
  }
  private mark(key: string, id: number, createdAt: string, target?: number) {
    const entry = this.next.mk[key] ?? { n: [], t: 0 };
    if (!entry.n.includes(id)) entry.n = [...entry.n, id].sort((a, b) => a - b);
    entry.t = Math.max(entry.t, Date.parse(createdAt));
    if (target !== undefined) entry.g = target;
    this.next.mk[key] = entry;
  }
  /** §4.4 step 1: creations, body/label edits and Issue/PR markers. */
  private async issues(
    viewer: string,
    created: ScmEvent[],
    edited: ScmEvent[],
  ) {
    const items = await this.list(
      'issues.list',
      {
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: 100,
        ...this.since(this.prev.iw),
      },
      issueListSchema,
      this.baseline ? 1 : ISSUE_PAGES,
    );
    for (const item of [...items].sort((a, b) => a.number - b.number)) {
      const ref = { repo: { ...this.repo }, number: item.number };
      const pr = item.pull_request !== undefined;
      const ids = commandIds(item.body);
      const known = this.prev.is[item.number];
      this.next.iw = later(this.next.iw, item.updated_at);
      if (known === undefined)
        created.push({
          type: 'repo.object_created',
          externalKey: `gh:created:${item.number}`,
          occurredAt: item.created_at,
          ref,
          author: item.user?.login ?? '',
          hasMarker: ids.length > 0,
          // The body as first sighted: it may already carry an owner edit.
          ...(pr
            ? {}
            : {
                bodyHash: bodyHash(item.body ?? ''),
                updatedAt: item.updated_at,
              }),
        });
      if (item.user?.login === viewer)
        for (const id of ids)
          this.mark(
            `${pr ? 'pr' : 'issue'}:${id}`,
            item.number,
            item.created_at,
          );
      if (pr) {
        this.next.is[item.number] = 0;
        continue;
      }
      const hash = bodyHash(item.body ?? '');
      const labels = labelNames(item.labels);
      const labelsHash = short(JSON.stringify(labels));
      const state: [string, string] = [hash.slice(0, 16), labelsHash];
      if (
        known !== undefined &&
        known !== 0 &&
        (known[0] !== state[0] || known[1] !== state[1])
      )
        edited.push({
          type: 'issue.edited',
          externalKey: `gh:issue:${item.number}:${hash}:${labelsHash}`,
          occurredAt: item.updated_at,
          issue: ref,
          bodyHash: hash,
          updatedAt: item.updated_at,
          labels,
        });
      this.next.is[item.number] = state;
    }
  }
  /** §4.4 step 6, repo-wide: one list request finds duplicate comment markers. */
  private async comments(viewer: string) {
    const items = await this.list(
      'comments.list',
      {
        sort: 'updated',
        direction: 'desc',
        per_page: 100,
        ...this.since(this.prev.cw),
      },
      commentListSchema,
      this.baseline ? 1 : COMMENT_PAGES,
    );
    for (const item of items) {
      this.next.cw = later(this.next.cw, item.updated_at);
      const target = issueNumber(item.issue_url);
      if (item.user?.login !== viewer || target === undefined) continue;
      for (const id of commandIds(item.body))
        this.mark(`comment:${id}`, item.id, item.created_at, target);
    }
  }
  /** §4.4 steps 2–3 and §4.5: `ai-office/` head PRs, including the final PR. */
  private async pulls(): Promise<ScmEvent[]> {
    const items = await this.list(
      'pulls.list',
      { state: 'all', sort: 'updated', direction: 'desc', per_page: 50 },
      pullListSchema,
      this.baseline ? 1 : PULL_PAGES,
      // Page on only while every PR on the page changed since the cursor.
      (page) => page.every((pr) => this.summaryChanged(pr)),
    );
    const events: ScmEvent[] = [];
    const seen = new Set<number>();
    for (const item of [...items].sort((a, b) => a.number - b.number)) {
      if (!item.head.ref.startsWith(PREFIX) || seen.has(item.number)) continue;
      seen.add(item.number);
      const known = this.prev.prs[item.number];
      const state = item.merged_at ? 'merged' : item.state;
      if (!known && this.baseline && state !== 'open') {
        // Terminal PRs that predate the cursor are recorded, not reported.
        this.next.prs[item.number] = {
          s: state,
          h: item.head.sha,
          b: item.base.ref,
          m: null,
        };
        continue;
      }
      if (
        known &&
        !this.summaryChanged(item) &&
        !(known.s === 'open' && known.m === null)
      )
        continue;
      const detail = (
        await this.read(
          'pulls.get',
          `pulls.get:${item.number}`,
          { number: item.number },
          pullSchema,
        )
      ).data;
      const s = detail.merged || detail.merged_at ? 'merged' : detail.state;
      const mergeable = s === 'open' ? (detail.mergeable ?? null) : null;
      const record = {
        s,
        h: detail.head.sha,
        b: detail.base.ref,
        m: mergeable,
      } as const;
      this.next.prs[item.number] = record;
      if (
        known &&
        known.s === record.s &&
        known.h === record.h &&
        known.b === record.b &&
        known.m === record.m
      )
        continue;
      events.push({
        type: 'pr.state',
        externalKey: `gh:pr:${item.number}:${s}:${record.h}:${mergeable}:${record.b}`,
        occurredAt: detail.updated_at,
        pr: { repo: { ...this.repo }, number: item.number },
        state: s,
        base: record.b,
        head: detail.head.ref,
        headSha: record.h,
        mergeable,
        ...(s === 'merged' && detail.merged_by?.login
          ? { mergedBy: detail.merged_by.login }
          : {}),
        ...(s === 'merged' && detail.merge_commit_sha
          ? { mergeCommitSha: detail.merge_commit_sha }
          : {}),
      });
    }
    return events;
  }
  private summaryChanged(pr: z.infer<typeof pullListSchema>[number]) {
    const known = this.prev.prs[pr.number];
    return (
      !known ||
      known.s !== (pr.merged_at ? 'merged' : pr.state) ||
      known.h !== pr.head.sha ||
      known.b !== pr.base.ref
    );
  }
  /** §4.4 step 5: checks of open PR heads until they reach success/failure. */
  private async checks(): Promise<ScmEvent[]> {
    const events: ScmEvent[] = [];
    for (const [number, pr] of Object.entries(this.next.prs)) {
      if (pr.s !== 'open') continue;
      const key = `${number}@${pr.h}`;
      const known = this.prev.ck[key];
      if (known === 'success' || known === 'failure') {
        this.next.ck[key] = known;
        continue;
      }
      const runs = await this.read(
        'commits.checkRuns',
        `checks:${pr.h}`,
        { sha: pr.h, query: { per_page: 100 } },
        checkRunsSchema,
      );
      const status = await this.read(
        'commits.status',
        `status:${pr.h}`,
        { sha: pr.h, query: { per_page: 100 } },
        combinedStatusSchema,
      );
      const rolled = rollupChecks(runs.data, status.data);
      this.next.ck[key] = rolled;
      if (rolled === known) continue;
      events.push({
        type: 'pr.checks',
        externalKey: `gh:checks:${number}:${pr.h}:${rolled}`,
        occurredAt: this.now,
        pr: { repo: { ...this.repo }, number: Number(number) },
        status: rolled,
      });
    }
    return events;
  }
  /** §4.4 step 4 (PP3): the default branch and `ai-office/` branch heads. */
  private async refs(defaultBranch: string): Promise<ScmEvent[]> {
    const listed = await this.list(
      'refs.list',
      { per_page: 100 },
      refListSchema,
      REF_PAGES,
    );
    const head = await this.read(
      'refs.get',
      `refs.get:${defaultBranch}`,
      { ref: defaultBranch },
      refSchema,
    );
    const current = new Map<string, string>();
    for (const ref of listed)
      if (ref.ref.startsWith(`refs/heads/${PREFIX}`))
        current.set(ref.ref.slice('refs/heads/'.length), ref.object.sha);
    current.set(defaultBranch, head.data.object.sha);
    const events: ScmEvent[] = [];
    this.next.refs = {};
    for (const [branch, sha] of [...current].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      this.next.refs[branch] = sha;
      const previous = this.prev.refs[branch] ?? null;
      if (previous === sha) continue;
      events.push({
        type: 'branch.head_changed',
        externalKey: `gh:ref:${branch}:${sha}`,
        occurredAt: this.now,
        branch,
        sha,
        previousSha: previous,
      });
    }
    return events;
  }
  /**
   * §4.8 backstop: a marker on two or more of the viewer's objects, reported
   * once the newest is past the create pending window (list lag has settled
   * and in-process retries no longer create).
   */
  private duplicates(): ScmEvent[] {
    const events: ScmEvent[] = [];
    const now = this.deps.clock();
    for (const [key, entry] of Object.entries(this.next.mk).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (entry.n.length < 2 || now - entry.t < CREATE_PENDING_WINDOW_MS)
        continue;
      const set = entry.n.join(',');
      if (this.next.dp[key] === set) continue;
      this.next.dp[key] = set;
      const kind = key.slice(0, key.indexOf(':')) as 'issue' | 'pr' | 'comment';
      const commandId = key.slice(kind.length + 1);
      events.push({
        type: 'object.duplicate',
        externalKey: `gh:dup:${commandId}:${set}`,
        occurredAt: new Date(entry.t).toISOString(),
        commandId,
        kind,
        ...(kind === 'comment'
          ? {
              target: { repo: { ...this.repo }, number: entry.g! },
              commentIds: entry.n.map(String),
            }
          : { numbers: entry.n }),
      });
    }
    return events;
  }
}
