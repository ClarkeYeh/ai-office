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
import type {
  IssueDraft,
  IssuePatch,
  LabelSpec,
  PrDraft,
  PrPatch,
  ReviewComment,
  ScmPort,
} from '../../ports/scm.js';

type RepoInfo = Awaited<ReturnType<ScmPort['inspectRepo']>>;
type ObjectState = {
  ref: IssueRef;
  kind: 'issue' | 'pr';
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed' | 'merged';
  updatedAt: string;
  comments: string[];
  reviews: ReviewComment[];
  base: string;
  head: string;
  mergeable: boolean | null;
  checks: 'pending' | 'success' | 'failure' | 'none';
  mergeCommitSha?: string;
  mergedBy?: string;
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
const hash = async (body: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');

/** In-memory SCM with deterministic IDs and replayable, change-only poll cursors. */
export class FakeScm implements ScmPort {
  private repos = new Map<string, RepoState>();
  private sequence = 0;
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
  private mergeDelayMs: number;
  constructor(private options: FakeScmOptions = {}) {
    this.mergeDelayMs = options.mergeDelayMs ?? 0;
    this.setMergeDelay(this.mergeDelayMs);
  }
  private now() {
    return (
      this.options.clock?.now() ?? new Date('2026-01-01T00:00:00Z')
    ).toISOString();
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
  }
  async deleteBranch(ref: RepoScmRef, name: string) {
    const repo = this.repo(ref);
    if (name === repo.info.defaultBranch || !name.startsWith('ai-office/'))
      throw new PortError(
        'guard',
        'branch_delete_guard',
        'Cannot delete this branch',
      );
    repo.branches.delete(name);
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
    const sha = this.sha();
    repo.parents.set(sha, [parent]);
    repo.branches.set(branch, sha);
    for (const obj of repo.objects.values())
      if (obj.kind === 'pr' && obj.head === branch) this.prState(obj);
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
      hasMarker: /<!-- ai-office:cmd=.+? -->/.test(obj.body),
    });
    return obj;
  }
  async createIssue(ref: RepoScmRef, draft: IssueDraft, c: Correlation) {
    const issue = structuredClone(
      this.create(
        ref,
        { ...draft, body: marked(draft.body, c.commandId) },
        'issue',
        this.repo(ref).info.viewerLogin,
      ).ref,
    );
    this.afterMutation('createIssue');
    return { ...issue, url: this.htmlUrl(issue, 'issues') };
  }
  private htmlUrl(ref: IssueRef | PrRef, kind: 'issues' | 'pull'): string {
    return `https://github.com/${ref.repo.owner}/${ref.repo.name}/${kind}/${ref.number}`;
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
    return { body, bodyHash: await hash(body), updatedAt, labels };
  }
  private async changed(obj: ObjectState) {
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
  async comment(ref: IssueRef | PrRef, body: string, c: Correlation) {
    const obj = this.object(ref);
    if (obj.comments.some((value) => value.includes(marker(c.commandId))))
      return;
    obj.comments.push(marked(body, c.commandId));
    await this.changed(obj);
    this.afterMutation('comment');
  }
  async addExternalComment(ref: IssueRef | PrRef, body: string) {
    const obj = this.object(ref);
    obj.comments.push(body);
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
      headSha: repo.branches.get(obj.head) ?? '',
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
    const after = this.options.autoMergeIntoDefaultBranchAfterMs;
    const repo = this.repo(obj.ref.repo);
    if (after === undefined || obj.base !== repo.info.defaultBranch) return;
    const wait =
      this.options.delay ??
      ((ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
    void wait(after).then(() => {
      try {
        if (obj.state === 'open') this.merge(obj, repo.info.viewerLogin);
      } catch {
        /* Branches changed meanwhile: the owner does not merge. */
      }
    });
  }
  setMergeDelay(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Invalid delay');
    this.mergeDelayMs = ms;
  }
  private checkMerge(obj: ObjectState, expectedHeadSha: string) {
    const repo = this.repo(obj.ref.repo);
    if (obj.base === repo.info.defaultBranch)
      throw new PortError(
        'guard',
        'default_branch_merge',
        'Cannot merge into the default branch',
      );
    if (repo.branches.get(obj.head) !== expectedHeadSha)
      throw new PortError('conflict', 'head_sha_mismatch', 'PR head changed');
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
  private merge(obj: ObjectState, author: string) {
    if (obj.mergeCommitSha) return { mergeCommitSha: obj.mergeCommitSha };
    const repo = this.repo(obj.ref.repo),
      base = repo.branches.get(obj.base),
      head = repo.branches.get(obj.head);
    if (!base || !head)
      throw new PortError('permanent', 'branch_not_found', 'Unknown PR branch');
    const sha = this.sha();
    repo.parents.set(sha, [base, head]);
    repo.branches.set(obj.base, sha);
    obj.state = 'merged';
    obj.mergeCommitSha = sha;
    obj.mergedBy = author;
    this.prState(obj);
    return { mergeCommitSha: sha };
  }
  async getPR(ref: PrRef): ReturnType<ScmPort['getPR']> {
    const obj = this.object(ref, 'pr');
    return {
      state: obj.state,
      ...(obj.mergeCommitSha ? { mergeCommitSha: obj.mergeCommitSha } : {}),
    };
  }
  async mergePR(
    ref: PrRef,
    opts: { method: 'merge'; expectedHeadSha: string },
  ) {
    const obj = this.object(ref, 'pr');
    this.checkMerge(obj, opts.expectedHeadSha);
    if (obj.mergeCommitSha) return { mergeCommitSha: obj.mergeCommitSha };
    if (this.mergeDelayMs)
      await (
        this.options.delay ??
        ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
      )(this.mergeDelayMs);
    this.checkMerge(obj, opts.expectedHeadSha);
    const result = this.merge(obj, this.repo(ref.repo).info.viewerLogin);
    this.afterMutation('mergePR');
    return result;
  }
  async mergeExternally(
    ref: PrRef,
    author = this.repo(ref.repo).info.viewerLogin,
  ) {
    return this.merge(this.object(ref, 'pr'), author);
  }
  async findByMarker(ref: RepoScmRef, commandId: string) {
    for (const obj of this.repo(ref).objects.values())
      if (
        [obj.body, ...obj.comments].some((body) =>
          body.includes(marker(commandId)),
        )
      )
        return structuredClone(obj.ref);
    return null;
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
