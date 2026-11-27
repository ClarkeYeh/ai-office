import { bodyHash } from '@ai-office/domain';
import { PortError } from '../../ports/errors.js';
import { ScmCursorSchema } from '../../ports/refs.js';
import type {
  IssueRef,
  PrRef,
  RepoScmRef,
  ScmCursor,
} from '../../ports/refs.js';
import type { Correlation } from '../../ports/runtime.js';
import type { ScmEvent } from '../../ports/scm-events.js';
import type { Clock } from '../../ports/services.js';
import {
  CREATE_PENDING_WINDOW_MS,
  CREATE_RETRY_AFTER_MS,
  MARKER_SCAN_SLACK_MS,
} from '../../ports/scm.js';
import type {
  IssueDraft,
  IssuePatch,
  LabelSpec,
  MarkerHint,
  MarkerMatch,
  PrDraft,
  PrPatch,
  ReviewComment,
  ScmPort,
  ViewerRepo,
} from '../../ports/scm.js';
import { VIEWER_REPOS_LIMIT } from '../../ports/scm.js';

type RepoInfo = Awaited<ReturnType<ScmPort['inspectRepo']>>;
type StoredComment = {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  /** Epoch ms from which list scans see it (`setListLag`). */
  listedAt: number;
};
type ObjectState = {
  ref: IssueRef;
  kind: 'issue' | 'pr';
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed' | 'merged';
  updatedAt: string;
  revision: number;
  listedAt: number;
  comments: StoredComment[];
  reviews: ReviewComment[];
  base: string;
  head: string;
  mergeable: boolean | null;
  checks: 'pending' | 'success' | 'failure' | 'none';
  mergeCommitSha?: string;
  mergedBy?: string;
  /** The head when merged, or when its branch was deleted. */
  headSha?: string;
};
type RepoState = {
  info: RepoInfo;
  branches: Map<string, string>;
  parents: Map<string, string[]>;
  objects: Map<number, ObjectState>;
  labels: Map<string, LabelSpec>;
  events: ScmEvent[];
};
export type FakeScmOptions = {
  clock?: Clock;
  mergeDelayMs?: number;
  /** Inject a virtual delay for timeout tests; the default uses setTimeout. */
  delay?: (ms: number) => Promise<void>;
  /**
   * Simulates the repository owner merging PRs into the default branch (the
   * final PR is merged by a human, §7.6) this long after they are opened.
   * Polling observes the merge like any external one.
   */
  autoMergeIntoDefaultBranchAfterMs?: number;
};
const key = (repo: RepoScmRef) => JSON.stringify([repo.owner, repo.name]);
const marker = (commandId: string) => `<!-- ai-office:cmd=${commandId} -->`;
const marked = (body: string, commandId: string) =>
  body.includes(marker(commandId)) ? body : `${body}\n${marker(commandId)}`;
const anyMarker = /<!-- ai-office:cmd=.+? -->/;
const managedBranch = (repo: RepoState, branch: string) =>
  branch === repo.info.defaultBranch || branch.startsWith('ai-office/');
const outcomeUnknown = () =>
  new PortError(
    'transient',
    'create_outcome_unknown',
    'Fake SCM create outcome unknown',
    true,
    CREATE_RETRY_AFTER_MS,
  );
type LostCreate = 'createIssue' | 'comment';

/** In-memory SCM with deterministic IDs and replayable, change-only poll cursors. */
export class FakeScm implements ScmPort {
  private repos = new Map<string, RepoState>();
  private sequence = 0;
  private ownerMerges = new Map<
    string,
    { ref: PrRef; at: number; revision: number }
  >();
  private mergeDeadlines = new Map<string, number>();
  private timerGeneration = 0;
  snapshot() {
    return structuredClone({
      version: 1 as const,
      sequence: this.sequence,
      repos: [...this.repos].map(
        ([name, repo]) =>
          [
            name,
            {
              ...repo,
              branches: [...repo.branches],
              parents: [...repo.parents],
              objects: [...repo.objects],
              labels: [...repo.labels],
            },
          ] as const,
      ),
      lostReplies: [...this.lostReplies],
      mergeDelayMs: this.mergeDelayMs,
      ...(this.ownerMergeDelayMs === undefined
        ? {}
        : { ownerMergeDelayMs: this.ownerMergeDelayMs }),
      ownerMerges: [...this.ownerMerges],
      mergeDeadlines: [...this.mergeDeadlines],
      commentSequence: this.commentSequence,
      listLagMs: this.listLagMs,
      lostCreates: [...this.lostCreates],
      pendingCreates: [...this.pendingCreates],
      retargets: [...this.retargets],
    });
  }
  restore(state: ReturnType<FakeScm['snapshot']>): void {
    if (state.version !== 1)
      throw new Error('Unsupported fake SCM snapshot version');
    const data = structuredClone(state);
    this.timerGeneration++;
    this.sequence = data.sequence;
    this.repos = new Map(
      data.repos.map(([name, repo]) => [
        name,
        {
          ...repo,
          branches: new Map(repo.branches),
          parents: new Map(repo.parents),
          objects: new Map(repo.objects),
          labels: new Map(repo.labels),
        },
      ]),
    );
    this.lostReplies = new Set(data.lostReplies);
    this.mergeDelayMs = data.mergeDelayMs;
    this.ownerMergeDelayMs = data.ownerMergeDelayMs;
    this.ownerMerges = new Map(data.ownerMerges);
    this.mergeDeadlines = new Map(data.mergeDeadlines);
    // Snapshots before M3-T2 lack these fields and store comments as text.
    this.commentSequence = data.commentSequence ?? 0;
    this.listLagMs = data.listLagMs ?? 0;
    this.lostCreates = new Set(data.lostCreates ?? []);
    this.pendingCreates = new Map(data.pendingCreates ?? []);
    this.retargets = new Map(data.retargets ?? []);
    for (const repo of this.repos.values())
      for (const obj of repo.objects.values()) {
        obj.listedAt ??= 0;
        obj.comments = (obj.comments as (StoredComment | string)[]).map(
          (comment) =>
            typeof comment === 'string'
              ? {
                  id: String(++this.commentSequence),
                  body: comment,
                  author: repo.info.viewerLogin,
                  createdAt: obj.updatedAt,
                  listedAt: 0,
                }
              : comment,
        );
      }
    for (const [id, pending] of this.ownerMerges)
      this.armOwnerMerge(id, pending);
  }
  private lostReplies = new Set<
    'createIssue' | 'openPR' | 'comment' | 'mergePR'
  >();
  injectResponseLost(
    operation: 'createIssue' | 'openPR' | 'comment' | 'mergePR',
  ): void {
    this.lostReplies.add(operation);
  }
  private afterMutation(
    operation: 'createIssue' | 'openPR' | 'comment' | 'mergePR',
  ): void {
    if (this.lostReplies.delete(operation))
      throw new PortError(
        'transient',
        'response_lost',
        'Fake SCM response lost after success',
        true,
      );
  }
  private commentSequence = 0;
  private listLagMs = 0;
  private lostCreates = new Set<LostCreate>();
  /** commandId → epoch ms of the create whose response was lost. */
  private pendingCreates = new Map<string, number>();
  /** PR key → base it is moved to during its next merge. */
  private retargets = new Map<string, string>();
  /**
   * The next create of this kind succeeds but answers
   * `create_outcome_unknown` with `retryAfterMs`, as scm-github does after a
   * timeout; retries scan markers within the pending window (SPEC §11.5).
   */
  loseNextResponse(operation: LostCreate): void {
    this.lostCreates.add(operation);
  }
  /** Issues and comments created from now on stay unlisted for `ms`. */
  setListLag(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Invalid lag');
    this.listLagMs = ms;
  }
  private created(operation: LostCreate, commandId: string): void {
    if (!this.lostCreates.delete(operation)) return;
    this.pendingCreates.set(commandId, this.nowMs());
    throw outcomeUnknown();
  }
  /** A retried create: the object a marker scan finds, or null to create. */
  private recover(
    ref: RepoScmRef,
    commandId: string,
    kind: 'issue' | 'comment',
  ): MarkerMatch | null {
    const first = this.pendingCreates.get(commandId);
    if (first === undefined) return null;
    const found = this.scan(ref, commandId, {
      since: new Date(first).toISOString(),
      kind,
    });
    if (found) {
      this.pendingCreates.delete(commandId);
      return found;
    }
    if (this.nowMs() - first < CREATE_PENDING_WINDOW_MS) throw outcomeUnknown();
    this.pendingCreates.delete(commandId);
    return null;
  }
  private mergeDelayMs: number;
  private ownerMergeDelayMs: number | undefined;
  constructor(private options: FakeScmOptions = {}) {
    this.mergeDelayMs = options.mergeDelayMs ?? 0;
    this.ownerMergeDelayMs = options.autoMergeIntoDefaultBranchAfterMs;
    this.setMergeDelay(this.mergeDelayMs);
  }
  private now() {
    return (
      this.options.clock?.now() ?? new Date('2026-01-01T00:00:00Z')
    ).toISOString();
  }
  private nowMs() {
    return Date.parse(this.now());
  }
  private sha() {
    return (++this.sequence).toString(16).padStart(40, '0');
  }
  private repo(ref: RepoScmRef) {
    const repo = this.repos.get(key(ref));
    if (!repo)
      throw new PortError(
        'permanent',
        'repo_not_found',
        'Unknown fake repository',
      );
    return repo;
  }
  private object(ref: IssueRef, kind?: ObjectState['kind']) {
    const obj = this.repo(ref.repo).objects.get(ref.number);
    if (!obj || (kind && obj.kind !== kind))
      throw new PortError(
        'permanent',
        'object_not_found',
        'Unknown fake object',
      );
    return obj;
  }
  private emit(repo: RepoState, event: ScmEvent) {
    repo.events.push(structuredClone(event));
  }
  private moved(
    repo: RepoState,
    branch: string,
    sha: string,
    previousSha: string | null,
  ) {
    if (managedBranch(repo, branch) && sha !== previousSha)
      this.emit(repo, {
        ...this.envelope(repo),
        type: 'branch.head_changed',
        branch,
        sha,
        previousSha,
      });
  }
  private envelope(repo: RepoState) {
    return {
      externalKey: `scm:${repo.events.length + 1}`,
      occurredAt: this.now(),
    };
  }
  addRepo(ref: RepoScmRef, info: Partial<RepoInfo> = {}): void {
    if (this.repos.has(key(ref)))
      throw new PortError(
        'conflict',
        'repo_exists',
        'Repository already exists',
      );
    const resolved = {
      defaultBranch: 'main',
      visibility: 'public' as const,
      defaultBranchProtected: true,
      viewerLogin: ref.owner,
      ...info,
    };
    const sha = this.sha();
    this.repos.set(key(ref), {
      info: resolved,
      branches: new Map([[resolved.defaultBranch, sha]]),
      parents: new Map([[sha, []]]),
      objects: new Map(),
      labels: new Map(),
      events: [],
    });
  }
  async health() {
    return {
      available: true,
      viewerLogin:
        this.repos.values().next().value?.info.viewerLogin ?? 'fake-user',
      rateLimitRemaining: 5000,
      rateLimitResetAt: this.now(),
    };
  }
  /** The viewer's own repos, most recently added first; the fake keeps no push times. */
  async listViewerRepos(): Promise<ViewerRepo[]> {
    const viewer = (await this.health()).viewerLogin.toLowerCase();
    return [...this.repos]
      .reverse()
      .flatMap(([id, repo]) => {
        const [owner, name] = JSON.parse(id) as [string, string];
        return owner.toLowerCase() === viewer
          ? [
              {
                owner,
                name,
                visibility: repo.info.visibility,
                archived: repo.info.archived ?? false,
                pushedAt: null,
                defaultBranch: repo.info.defaultBranch,
              },
            ]
          : [];
      })
      .slice(0, VIEWER_REPOS_LIMIT);
  }
  async inspectRepo(ref: RepoScmRef) {
    return structuredClone(this.repo(ref).info);
  }
  async ensureLabels(ref: RepoScmRef, labels: LabelSpec[]) {
    for (const label of labels)
      this.repo(ref).labels.set(label.name, structuredClone(label));
  }
  async ensureBranch(
    ref: RepoScmRef,
    name: string,
    from: string,
    c: Correlation,
  ) {
    void c;
    const repo = this.repo(ref);
    if (name === repo.info.defaultBranch || !name.startsWith('ai-office/'))
      throw new PortError(
        'guard',
        'branch_guard',
        'Only ai-office/ branches may be created',
      );
    if (repo.branches.has(name)) return;
    const sha =
      repo.branches.get(from) ?? (repo.parents.has(from) ? from : undefined);
    if (!sha)
      throw new PortError(
        'permanent',
        'branch_not_found',
        'Unknown source branch',
      );
    repo.branches.set(name, sha);
    this.moved(repo, name, sha, null);
  }
  async deleteBranch(ref: RepoScmRef, name: string) {
    const repo = this.repo(ref);
    if (name === repo.info.defaultBranch || !name.startsWith('ai-office/'))
      throw new PortError(
        'guard',
        'branch_delete_guard',
        'Cannot delete this branch',
      );
    const sha = repo.branches.get(name);
    if (sha === undefined) return;
    repo.branches.delete(name);
    // GitHub closes open PRs whose head branch is deleted (G9).
    for (const obj of repo.objects.values())
      if (obj.kind === 'pr' && obj.state === 'open' && obj.head === name) {
        obj.headSha = sha;
        obj.state = 'closed';
        obj.revision++;
        obj.updatedAt = this.now();
        this.prState(obj);
      }
  }
  private ancestors(repo: RepoState, sha: string): Set<string> {
    const seen = new Set<string>();
    const pending = [sha];
    while (pending.length) {
      const next = pending.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(...(repo.parents.get(next) ?? []));
    }
    return seen;
  }
  async compareBranch(ref: RepoScmRef, base: string, head: string) {
    // Like GitHub's compare API, either side may be a branch or a commit SHA.
    const repo = this.repo(ref),
      resolve = (name: string) =>
        repo.branches.get(name) ?? (repo.parents.has(name) ? name : undefined),
      baseSha = resolve(base),
      headSha = resolve(head);
    if (!baseSha || !headSha) return null;
    const baseAncestors = this.ancestors(repo, baseSha);
    return {
      ahead: [...this.ancestors(repo, headSha)].filter(
        (sha) => !baseAncestors.has(sha),
      ).length,
      headSha,
    };
  }
  /**
   * Simulate an external push, including a push to the default branch. A new
   * branch needs `from` (a branch or commit), as `git push` of a fresh branch.
   */
  pushBranch(ref: RepoScmRef, branch: string, from?: string): string {
    const repo = this.repo(ref),
      parent =
        repo.branches.get(branch) ??
        (from === undefined
          ? undefined
          : (repo.branches.get(from) ??
            (repo.parents.has(from) ? from : undefined)));
    if (!parent)
      throw new PortError('permanent', 'branch_not_found', 'Unknown branch');
    const sha = this.sha(),
      previous = repo.branches.get(branch) ?? null;
    repo.parents.set(sha, [parent]);
    repo.branches.set(branch, sha);
    this.moved(repo, branch, sha, previous);
    for (const obj of repo.objects.values())
      if (obj.kind === 'pr' && obj.head === branch) {
        obj.revision++;
        this.prState(obj);
      }
    return sha;
  }
  private create(
    ref: RepoScmRef,
    draft: IssueDraft | PrDraft,
    kind: ObjectState['kind'],
    author: string,
  ): ObjectState {
    const repo = this.repo(ref);
    const obj: ObjectState = {
      ref: { repo: structuredClone(ref), number: repo.objects.size + 1 },
      kind,
      title: draft.title,
      body: draft.body,
      labels: 'labels' in draft ? [...draft.labels] : [],
      state: 'open',
      updatedAt: this.now(),
      revision: 0,
      // PRs have GitHub's head/base uniqueness; only Issues can duplicate.
      listedAt: this.nowMs() + (kind === 'issue' ? this.listLagMs : 0),
      comments: [],
      reviews: [],
      base: 'base' in draft ? draft.base : '',
      head: 'head' in draft ? draft.head : '',
      mergeable: true,
      checks: 'none',
    };
    repo.objects.set(obj.ref.number, obj);
    this.emit(repo, {
      ...this.envelope(repo),
      type: 'repo.object_created',
      ref: obj.ref,
      author,
      hasMarker: anyMarker.test(obj.body),
      ...(kind === 'issue'
        ? { bodyHash: bodyHash(obj.body), updatedAt: obj.updatedAt }
        : {}),
    });
    return obj;
  }
  /** PP7: one marker on several Issues/PRs, as poll would see it (§4.8). */
  private duplicates(repo: RepoState, commandId: string, kind: 'issue' | 'pr') {
    const numbers = [...repo.objects.values()]
      .filter((o) => o.kind === kind && o.body.includes(marker(commandId)))
      .map((o) => o.ref.number);
    if (numbers.length > 1)
      this.emit(repo, {
        ...this.envelope(repo),
        type: 'object.duplicate',
        commandId,
        kind,
        numbers,
      });
  }
  async createIssue(ref: RepoScmRef, draft: IssueDraft, c: Correlation) {
    const found = this.recover(ref, c.commandId, 'issue');
    if (found)
      return { repo: found.repo, number: found.number, url: found.url };
    const issue = structuredClone(
      this.create(
        ref,
        { ...draft, body: marked(draft.body, c.commandId) },
        'issue',
        this.repo(ref).info.viewerLogin,
      ).ref,
    );
    this.duplicates(this.repo(ref), c.commandId, 'issue');
    this.created('createIssue', c.commandId);
    this.afterMutation('createIssue');
    return { ...issue, url: this.htmlUrl(issue, 'issues') };
  }
  private htmlUrl(ref: IssueRef | PrRef, kind: 'issues' | 'pull'): string {
    return `https://github.com/${ref.repo.owner}/${ref.repo.name}/${kind}/${ref.number}`;
  }
  private objectUrl(obj: ObjectState): string {
    return this.htmlUrl(obj.ref, obj.kind === 'pr' ? 'pull' : 'issues');
  }
  async createExternalIssue(
    ref: RepoScmRef,
    draft: IssueDraft,
    author = this.repo(ref).info.viewerLogin,
  ) {
    return structuredClone(this.create(ref, draft, 'issue', author).ref);
  }
  async getIssue(ref: IssueRef) {
    const obj = this.object(ref, 'issue');
    const { body, updatedAt, labels } = structuredClone(obj);
    return { body, bodyHash: bodyHash(body), updatedAt, labels };
  }
  private async changed(obj: ObjectState) {
    obj.revision++;
    obj.updatedAt = this.now();
    if (obj.kind === 'pr') {
      this.prState(obj);
      return;
    }
    const snapshot = await this.getIssue(obj.ref),
      repo = this.repo(obj.ref.repo);
    this.emit(repo, {
      ...this.envelope(repo),
      type: 'issue.edited',
      issue: obj.ref,
      bodyHash: snapshot.bodyHash,
      updatedAt: snapshot.updatedAt,
      labels: snapshot.labels,
    });
  }
  async updateIssue(ref: IssueRef, patch: IssuePatch) {
    const obj = this.object(ref, 'issue');
    Object.assign(obj, patch);
    await this.changed(obj);
  }
  async editIssueBody(ref: IssueRef, body: string) {
    await this.updateIssue(ref, { body });
  }
  private addComment(obj: ObjectState, body: string, author: string) {
    obj.comments.push({
      id: String(++this.commentSequence),
      body,
      author,
      createdAt: this.now(),
      listedAt: this.nowMs() + this.listLagMs,
    });
  }
  async comment(ref: IssueRef | PrRef, body: string, c: Correlation) {
    const obj = this.object(ref),
      repo = this.repo(ref.repo);
    if (this.recover(ref.repo, c.commandId, 'comment')) return;
    const now = this.nowMs(),
      mine = (value: StoredComment) => value.body.includes(marker(c.commandId));
    if (obj.comments.some((value) => value.listedAt <= now && mine(value)))
      return;
    this.addComment(obj, marked(body, c.commandId), repo.info.viewerLogin);
    const commentIds = obj.comments.filter(mine).map((value) => value.id);
    if (commentIds.length > 1)
      this.emit(repo, {
        ...this.envelope(repo),
        type: 'object.duplicate',
        commandId: c.commandId,
        kind: 'comment',
        target: structuredClone(obj.ref),
        commentIds,
      });
    await this.changed(obj);
    this.created('comment', c.commandId);
    this.afterMutation('comment');
  }
  async deleteComment(target: IssueRef | PrRef, commentId: string) {
    const obj = this.object(target),
      index = obj.comments.findIndex((value) => value.id === commentId);
    if (index < 0) return;
    const found = obj.comments[index]!;
    if (
      found.author !== this.repo(target.repo).info.viewerLogin ||
      !anyMarker.test(found.body)
    )
      throw new PortError(
        'guard',
        'comment_delete_guard',
        'Only the viewer’s marked comments may be deleted',
      );
    obj.comments.splice(index, 1);
    await this.changed(obj);
  }
  async addExternalComment(
    ref: IssueRef | PrRef,
    body: string,
    author = this.repo(ref.repo).info.viewerLogin,
  ) {
    const obj = this.object(ref);
    this.addComment(obj, body, author);
    await this.changed(obj);
  }
  async setLabels(ref: IssueRef | PrRef, labels: string[]) {
    const obj = this.object(ref);
    obj.labels = [...new Set(labels)];
    await this.changed(obj);
  }
  async openPR(ref: RepoScmRef, draft: PrDraft, c: Correlation) {
    const repo = this.repo(ref);
    if (!repo.branches.has(draft.base) || !repo.branches.has(draft.head))
      throw new PortError('permanent', 'branch_not_found', 'Unknown PR branch');
    const obj = this.create(
      ref,
      { ...draft, body: marked(draft.body, c.commandId) },
      'pr',
      repo.info.viewerLogin,
    );
    this.prState(obj);
    this.setChecks(obj.ref, 'none');
    this.scheduleOwnerMerge(obj);
    this.afterMutation('openPR');
    return { ...structuredClone(obj.ref), url: this.htmlUrl(obj.ref, 'pull') };
  }
  async updatePR(ref: PrRef, patch: PrPatch) {
    const obj = this.object(ref, 'pr');
    if (obj.state === 'merged' && patch.state)
      throw new PortError('conflict', 'pr_merged', 'PR already merged');
    Object.assign(obj, patch);
    await this.changed(obj);
  }
  private prState(obj: ObjectState) {
    const repo = this.repo(obj.ref.repo);
    this.emit(repo, {
      ...this.envelope(repo),
      type: 'pr.state',
      pr: obj.ref,
      state: obj.state,
      base: obj.base,
      head: obj.head,
      headSha: repo.branches.get(obj.head) ?? obj.headSha ?? '',
      mergeable: obj.mergeable,
      ...(obj.mergedBy ? { mergedBy: obj.mergedBy } : {}),
      ...(obj.mergeCommitSha ? { mergeCommitSha: obj.mergeCommitSha } : {}),
    });
  }
  setChecks(ref: PrRef, status: ObjectState['checks']) {
    const obj = this.object(ref, 'pr'),
      repo = this.repo(ref.repo);
    obj.checks = status;
    this.emit(repo, {
      ...this.envelope(repo),
      type: 'pr.checks',
      pr: ref,
      status,
    });
  }
  setMergeable(ref: PrRef, value: boolean | null) {
    const obj = this.object(ref, 'pr');
    obj.mergeable = value;
    this.prState(obj);
  }
  private scheduleOwnerMerge(obj: ObjectState) {
    const after = this.ownerMergeDelayMs;
    const repo = this.repo(obj.ref.repo);
    if (after === undefined || obj.base !== repo.info.defaultBranch) return;
    const id = JSON.stringify(obj.ref);
    const pending = {
      ref: structuredClone(obj.ref),
      at: Date.parse(this.now()) + after,
      revision: obj.revision,
    };
    this.ownerMerges.set(id, pending);
    this.armOwnerMerge(id, pending);
  }
  private armOwnerMerge(
    id: string,
    pending: { ref: PrRef; at: number; revision: number },
  ) {
    const generation = this.timerGeneration;
    const wait =
      this.options.delay ??
      ((ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
    void wait(Math.max(0, pending.at - Date.parse(this.now()))).then(() => {
      if (
        generation !== this.timerGeneration ||
        this.ownerMerges.get(id) !== pending
      )
        return;
      this.ownerMerges.delete(id);
      try {
        const obj = this.object(pending.ref, 'pr');
        if (obj.state === 'open' && obj.revision === pending.revision)
          this.merge(obj, this.repo(obj.ref.repo).info.viewerLogin);
      } catch {
        /* Branches changed meanwhile: the owner does not merge. */
      }
    });
  }
  setMergeDelay(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Invalid delay');
    this.mergeDelayMs = ms;
  }
  /** Moves the PR's base: now, or between the next merge's base read and merge. */
  async retargetExternally(
    ref: PrRef,
    base: string,
    when: 'now' | 'during-next-merge' = 'now',
  ) {
    const obj = this.object(ref, 'pr');
    if (!this.repo(ref.repo).branches.has(base))
      throw new PortError('permanent', 'branch_not_found', 'Unknown PR base');
    if (when === 'during-next-merge') {
      this.retargets.set(JSON.stringify(obj.ref), base);
      return;
    }
    obj.base = base;
    await this.changed(obj);
  }
  private checkMerge(
    obj: ObjectState,
    opts: {
      expectedHeadSha: string;
      expectedBaseSha?: string;
      expectedBase?: string;
    },
  ) {
    const repo = this.repo(obj.ref.repo);
    // The PR's actual base decides, whatever the command asked for.
    if (obj.base === repo.info.defaultBranch)
      throw new PortError(
        'guard',
        'default_branch_merge',
        'Cannot merge into the default branch',
      );
    if (!obj.base.startsWith('ai-office/'))
      throw new PortError(
        'guard',
        'base_not_ai_office',
        'Only ai-office/ bases may be merged into',
      );
    if (opts.expectedBase !== undefined && obj.base !== opts.expectedBase)
      throw new PortError(
        'conflict',
        'base_mismatch',
        'PR base is not the expected base',
      );
    if (obj.state === 'merged') {
      // Pre-M3 snapshots did not freeze the merged head.
      if ((obj.headSha ?? repo.branches.get(obj.head)) !== opts.expectedHeadSha)
        throw new PortError('conflict', 'head_sha_mismatch', 'PR head changed');
      return;
    }
    if (repo.branches.get(obj.head) !== opts.expectedHeadSha)
      throw new PortError('conflict', 'head_sha_mismatch', 'PR head changed');
    if (
      opts.expectedBaseSha !== undefined &&
      repo.branches.get(obj.base) !== opts.expectedBaseSha
    )
      throw new PortError('conflict', 'base_moved', 'PR base moved');
    if (
      obj.state === 'closed' ||
      obj.mergeable !== true ||
      obj.checks === 'failure' ||
      obj.checks === 'pending'
    )
      throw new PortError(
        'conflict',
        'pr_not_mergeable',
        'PR cannot be merged',
      );
  }
  private merge(obj: ObjectState, author: string, into = obj.base) {
    if (obj.mergeCommitSha) return { mergeCommitSha: obj.mergeCommitSha };
    const repo = this.repo(obj.ref.repo),
      base = repo.branches.get(into),
      head = repo.branches.get(obj.head);
    if (!base || !head)
      throw new PortError('permanent', 'branch_not_found', 'Unknown PR branch');
    const sha = this.sha();
    repo.parents.set(sha, [base, head]);
    repo.branches.set(into, sha);
    obj.state = 'merged';
    obj.mergeCommitSha = sha;
    obj.mergedBy = author;
    obj.headSha = head;
    this.moved(repo, into, sha, base);
    this.prState(obj);
    return { mergeCommitSha: sha };
  }
  async getPR(ref: PrRef): ReturnType<ScmPort['getPR']> {
    const obj = this.object(ref, 'pr');
    return {
      state: obj.state,
      ...(obj.mergeCommitSha ? { mergeCommitSha: obj.mergeCommitSha } : {}),
      headSha: obj.headSha ?? this.repo(ref.repo).branches.get(obj.head) ?? '',
      base: obj.base,
      ...(obj.mergedBy ? { mergedBy: obj.mergedBy } : {}),
    };
  }
  async mergePR(
    ref: PrRef,
    opts: {
      method: 'merge';
      expectedHeadSha: string;
      expectedBaseSha?: string;
      expectedBase?: string;
    },
  ) {
    const obj = this.object(ref, 'pr');
    this.checkMerge(obj, opts);
    if (obj.mergeCommitSha) return { mergeCommitSha: obj.mergeCommitSha };
    const base = obj.base;
    const deadlineKey = JSON.stringify([ref, opts.expectedHeadSha]);
    const deadline =
      this.mergeDeadlines.get(deadlineKey) ??
      Date.parse(this.now()) + this.mergeDelayMs;
    this.mergeDeadlines.set(deadlineKey, deadline);
    if (deadline > Date.parse(this.now()))
      await (
        this.options.delay ??
        ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
      )(Math.max(0, deadline - Date.parse(this.now())));
    this.mergeDeadlines.delete(deadlineKey);
    this.checkMerge(obj, opts);
    const retarget = this.retargets.get(JSON.stringify(obj.ref));
    if (retarget !== undefined) {
      this.retargets.delete(JSON.stringify(obj.ref));
      obj.base = retarget;
    }
    // Like scm-github's POST /merges: into the base that was checked.
    const result = this.merge(obj, this.repo(ref.repo).info.viewerLogin, base);
    if (obj.base !== base)
      throw new PortError(
        'guard',
        'merge_base_changed',
        'PR base changed while merging',
      );
    this.afterMutation('mergePR');
    return result;
  }
  /** Explicit simulated owner action; never used by the backend ScmPort. */
  async mergeOwner(ref: PrRef) {
    const obj = this.object(ref, 'pr');
    if (
      obj.base !== this.repo(ref.repo).info.defaultBranch ||
      obj.state === 'closed'
    )
      throw new PortError(
        'guard',
        'not_open_final_pr',
        'Expected an open final PR',
      );
    return this.merge(obj, this.repo(ref.repo).info.viewerLogin);
  }
  async mergeExternally(
    ref: PrRef,
    author = this.repo(ref.repo).info.viewerLogin,
  ) {
    return this.merge(this.object(ref, 'pr'), author);
  }
  /** A list scan: lagging objects are invisible; the lowest match is kept. */
  private scan(
    ref: RepoScmRef,
    commandId: string,
    hint: MarkerHint = {},
  ): MarkerMatch | null {
    const repo = this.repo(ref),
      now = this.nowMs(),
      from =
        hint.since === undefined
          ? -Infinity
          : Date.parse(hint.since) - MARKER_SCAN_SLACK_MS,
      listed = (at: number, time: string) =>
        at <= now && Date.parse(time) >= from,
      objects = [...repo.objects.values()];
    const bodies = objects.filter(
      (o) =>
        (hint.kind === undefined || hint.kind === o.kind) &&
        listed(o.listedAt, o.updatedAt) &&
        o.body.includes(marker(commandId)),
    );
    if (bodies.length) {
      const [keeper] = bodies;
      return {
        ...structuredClone(keeper!.ref),
        kind: keeper!.kind,
        url: this.objectUrl(keeper!),
        ...(bodies.length > 1 ? { duplicates: bodies.length - 1 } : {}),
      };
    }
    if (hint.kind !== undefined && hint.kind !== 'comment') return null;
    const comments = objects
      .flatMap((obj) =>
        obj.comments
          .filter(
            (value) =>
              listed(value.listedAt, value.createdAt) &&
              value.body.includes(marker(commandId)),
          )
          .map((value) => ({ obj, id: value.id })),
      )
      .sort((a, b) => Number(a.id) - Number(b.id));
    const [keeper] = comments;
    if (!keeper) return null;
    return {
      ...structuredClone(keeper.obj.ref),
      kind: 'comment',
      url: `${this.objectUrl(keeper.obj)}#issuecomment-${keeper.id}`,
      commentId: keeper.id,
      ...(comments.length > 1 ? { duplicates: comments.length - 1 } : {}),
    };
  }
  async findByMarker(ref: RepoScmRef, commandId: string, hint?: MarkerHint) {
    return this.scan(ref, commandId, hint);
  }
  async listReviewComments(ref: PrRef) {
    return structuredClone(this.object(ref, 'pr').reviews);
  }
  addReviewComment(ref: PrRef, comment: ReviewComment) {
    this.object(ref, 'pr').reviews.push(structuredClone(comment));
  }
  /** Copies for scenario assertions; callers cannot mutate adapter state. */
  inspectObject(ref: IssueRef | PrRef) {
    return structuredClone(this.object(ref));
  }
  async poll(ref: RepoScmRef, cursor: ScmCursor | null) {
    const repo = this.repo(ref),
      prefix = `${key(ref)}:`;
    const offset = cursor === null ? 0 : Number(cursor.slice(prefix.length));
    if (
      (cursor !== null && !cursor.startsWith(prefix)) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > repo.events.length
    )
      throw new PortError('validation', 'invalid_cursor', 'Invalid SCM cursor');
    return {
      events: structuredClone(repo.events.slice(offset)).map((event) => ({
        ...event,
        externalKey: `${key(ref)}:${event.externalKey}`,
      })),
      cursor: ScmCursorSchema.parse(`${prefix}${repo.events.length}`),
    };
  }
}
export const createFakeScm = (options: FakeScmOptions = {}) =>
  new FakeScm(options);
