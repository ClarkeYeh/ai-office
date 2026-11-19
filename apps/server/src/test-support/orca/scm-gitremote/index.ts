import { bodyHash } from '@ai-office/domain';
import { PortError } from '../../../ports/errors.js';
import {
  ScmCursorSchema,
  type IssueRef,
  type PrRef,
  type RepoScmRef,
  type ScmCursor,
} from '../../../ports/refs.js';
import type { Correlation } from '../../../ports/runtime.js';
import type { Clock } from '../../../ports/services.js';
import {
  CREATE_PENDING_WINDOW_MS,
  CREATE_RETRY_AFTER_MS,
  MARKER_SCAN_SLACK_MS,
} from '../../../ports/scm.js';
import type {
  MarkerHint,
  MarkerMatch,
  ScmPort,
  IssueDraft,
  IssuePatch,
  PrDraft,
  PrPatch,
  LabelSpec,
  ReviewComment,
} from '../../../ports/scm.js';
import type { ScmEvent } from '../../../ports/scm-events.js';
import { git, TestGitRemote, type GitRemoteOptions } from './git.js';

type StoredComment = {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  listedAt: number;
};
type ObjectState = {
  ref: IssueRef;
  kind: 'issue' | 'pr';
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed' | 'merged';
  base: string;
  head: string;
  headSha: string;
  comments: StoredComment[];
  reviews: ReviewComment[];
  updatedAt: string;
  /** Epoch ms from which list scans see it (`setListLag`). */
  listedAt: number;
  mergeCommitSha?: string;
};
const VIEWER = 'scm-test';
const marker = (id: string) => `<!-- ai-office:cmd=${id} -->`;
const anyMarker = /<!-- ai-office:cmd=.+? -->/;
function fail(
  category: 'guard' | 'conflict' | 'permanent' | 'validation',
  code: string,
): never {
  throw new PortError(category, code, `Test SCM: ${code}`);
}
const outcomeUnknown = () =>
  new PortError(
    'transient',
    'create_outcome_unknown',
    'Test SCM: create_outcome_unknown',
    true,
    CREATE_RETRY_AFTER_MS,
  );
type LostCreate = 'createIssue' | 'comment';

/** Test-only SCM: real git history, in-memory GitHub objects. Never compose in production. */
export class GitRemoteScm implements ScmPort {
  private objects = new Map<number, ObjectState>();
  private labels = new Map<string, LabelSpec>();
  private events: ScmEvent[] = [];
  /** Last polled heads of the default and test branches (PP3). */
  private refs = new Map<string, string>();
  private commentSequence = 0;
  private listLagMs = 0;
  private lostCreates = new Set<LostCreate>();
  private pendingCreates = new Map<string, number>();
  private retargets = new Map<number, string>();
  private constructor(
    private readonly remote: TestGitRemote,
    private readonly repo: RepoScmRef,
    private readonly clock: Clock,
  ) {}
  static async create(
    options: GitRemoteOptions & { repo?: RepoScmRef; clock?: Clock },
  ): Promise<GitRemoteScm> {
    const repo = options.repo ?? {
      owner: 'ClarkeYeh',
      name: 'ai-office-spike',
    };
    if (
      options.harness &&
      (repo.owner !== 'ClarkeYeh' || repo.name !== 'ai-office-spike')
    )
      fail('guard', 'repo');
    return new GitRemoteScm(
      await TestGitRemote.create(options),
      structuredClone(repo),
      options.clock ?? { now: () => new Date() },
    );
  }
  private now() {
    return this.clock.now().toISOString();
  }
  private nowMs() {
    return this.clock.now().getTime();
  }
  private get defaultBranch() {
    return this.remote.options.defaultBranch ?? 'main';
  }
  /** The next create of this kind succeeds but answers `create_outcome_unknown`. */
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
  /** A retried create: what a marker scan finds, or null to create again. */
  private recover(commandId: string, kind: 'issue' | 'comment') {
    const first = this.pendingCreates.get(commandId);
    if (first === undefined) return null;
    const found = this.scan(commandId, {
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
  dispose(): Promise<void> {
    return this.remote.dispose();
  }
  private tracked(branch: string): boolean {
    try {
      this.remote.guard(branch);
      return true;
    } catch {
      return false;
    }
  }
  private check(repo: RepoScmRef): void {
    if (repo.owner !== this.repo.owner || repo.name !== this.repo.name)
      fail('guard', 'repo');
  }
  private object(ref: IssueRef, kind?: ObjectState['kind']): ObjectState {
    this.check(ref.repo);
    const object = this.objects.get(ref.number);
    if (!object || (kind && object.kind !== kind))
      return fail('permanent', 'object_not_found');
    return object;
  }
  private emit(event: ScmEvent): void {
    this.events.push(structuredClone(event));
  }
  private envelope() {
    return {
      externalKey: `gitremote:${this.repo.owner}/${this.repo.name}:${this.events.length + 1}`,
      occurredAt: this.now(),
    };
  }
  private url(obj: ObjectState) {
    return `https://github.com/${this.repo.owner}/${this.repo.name}/${obj.kind === 'pr' ? 'pull' : 'issues'}/${obj.ref.number}`;
  }
  async health() {
    return {
      available: true,
      viewerLogin: VIEWER,
      rateLimitRemaining: 5000,
      rateLimitResetAt: this.now(),
    };
  }
  async inspectRepo(repo: RepoScmRef) {
    this.check(repo);
    return {
      defaultBranch: this.defaultBranch,
      visibility: 'public' as const,
      defaultBranchProtected: true,
      viewerLogin: VIEWER,
    };
  }
  async ensureLabels(repo: RepoScmRef, labels: LabelSpec[]) {
    this.check(repo);
    for (const label of labels)
      this.labels.set(label.name, structuredClone(label));
  }
  async ensureBranch(
    repo: RepoScmRef,
    name: string,
    from: string,
    correlation: Correlation,
  ): Promise<void> {
    this.check(repo);
    this.remote.guard(name);
    void correlation; // Branch existence supplies idempotency; no marker can be stored in git refs.
    await this.remote.serial(async () => {
      const heads = await this.remote.heads();
      if (heads.has(name)) {
        await this.remote.own(name);
        return;
      }
      await this.remote.fetch();
      const sha = await this.remote.resolve(from, heads);
      if (!sha) fail('permanent', 'branch_not_found');
      await this.remote.own(name, true);
      await this.remote.push(name, sha, '');
    });
  }
  async deleteBranch(repo: RepoScmRef, name: string): Promise<void> {
    this.check(repo);
    this.remote.guard(name);
    await this.remote.serial(async () => {
      const sha = (await this.remote.heads()).get(name);
      if (!sha) return;
      await this.remote.push(name, '', sha);
      // GitHub closes open PRs whose head branch is deleted (G9).
      for (const obj of this.objects.values())
        if (obj.kind === 'pr' && obj.state === 'open' && obj.head === name) {
          obj.headSha = sha;
          obj.state = 'closed';
          this.changed(obj);
        }
      const harness = this.remote.options.harness;
      if (harness) {
        const entry = harness.ledger.remoteBranches.find(
          (b) => b.id === name && !b.done,
        );
        if (entry) entry.done = true;
        await harness.persist();
      }
    });
  }
  async compareBranch(repo: RepoScmRef, base: string, head: string) {
    this.check(repo);
    return this.remote.serial(async () => {
      const heads = await this.remote.heads();
      const headSha = heads.get(head);
      if (!headSha) return null;
      await this.remote.fetch();
      const baseSha = await this.remote.resolve(base, heads);
      if (!baseSha) return null;
      return {
        ahead: Number(
          await git(this.remote.path, [
            'rev-list',
            '--count',
            `${baseSha}..${headSha}`,
          ]),
        ),
        headSha,
      };
    });
  }
  private create(
    draft: IssueDraft | PrDraft,
    kind: ObjectState['kind'],
    c: Correlation,
  ): ObjectState {
    const now = this.nowMs();
    const previous = [...this.objects.values()].find(
      (o) =>
        o.kind === kind &&
        o.listedAt <= now &&
        o.body.includes(marker(c.commandId)),
    );
    if (previous) return previous;
    const obj: ObjectState = {
      ref: { repo: structuredClone(this.repo), number: this.objects.size + 1 },
      kind,
      title: draft.title,
      body: `${draft.body}\n\n${marker(c.commandId)}`,
      labels: 'labels' in draft ? [...draft.labels] : [],
      state: 'open',
      base: 'base' in draft ? draft.base : '',
      head: 'head' in draft ? draft.head : '',
      headSha: '',
      comments: [],
      reviews: [],
      updatedAt: this.now(),
      // PRs have GitHub's head/base uniqueness; only Issues can duplicate.
      listedAt: now + (kind === 'issue' ? this.listLagMs : 0),
    };
    this.objects.set(obj.ref.number, obj);
    this.emit({
      ...this.envelope(),
      type: 'repo.object_created',
      ref: obj.ref,
      author: VIEWER,
      hasMarker: true,
    });
    const numbers = [...this.objects.values()]
      .filter((o) => o.kind === kind && o.body.includes(marker(c.commandId)))
      .map((o) => o.ref.number);
    if (numbers.length > 1)
      this.emit({
        ...this.envelope(),
        type: 'object.duplicate',
        commandId: c.commandId,
        kind,
        numbers,
      });
    // A GitHub poll reports a new issue with its body hash; the conclusion
    // gate takes its GitHub version from that (M2-T17: without it every
    // approval was a 409 against the marker-bearing body).
    if (kind === 'issue') this.changed(obj);
    return obj;
  }
  /** Test-only: an Issue filed by hand, without a command marker. */
  createExternalIssue(draft: { title: string; body: string }): IssueRef {
    const obj: ObjectState = {
      ref: { repo: structuredClone(this.repo), number: this.objects.size + 1 },
      kind: 'issue',
      title: draft.title,
      body: draft.body,
      labels: [],
      state: 'open',
      base: '',
      head: '',
      headSha: '',
      comments: [],
      reviews: [],
      updatedAt: this.now(),
      listedAt: this.nowMs(),
    };
    this.objects.set(obj.ref.number, obj);
    this.emit({
      ...this.envelope(),
      type: 'repo.object_created',
      ref: obj.ref,
      author: VIEWER,
      hasMarker: anyMarker.test(obj.body),
    });
    return structuredClone(obj.ref);
  }
  async createIssue(repo: RepoScmRef, draft: IssueDraft, c: Correlation) {
    this.check(repo);
    const found = this.recover(c.commandId, 'issue');
    if (found)
      return { repo: found.repo, number: found.number, url: found.url };
    const obj = this.create(draft, 'issue', c);
    this.created('createIssue', c.commandId);
    return { ...structuredClone(obj.ref), url: this.url(obj) };
  }
  async getIssue(ref: IssueRef) {
    const obj = this.object(ref, 'issue');
    return {
      body: obj.body,
      bodyHash: bodyHash(obj.body),
      updatedAt: obj.updatedAt,
      labels: [...obj.labels],
    };
  }
  private changed(obj: ObjectState) {
    obj.updatedAt = this.now();
    if (obj.kind === 'pr') this.prState(obj);
    else
      this.emit({
        ...this.envelope(),
        type: 'issue.edited',
        issue: obj.ref,
        bodyHash: bodyHash(obj.body),
        updatedAt: obj.updatedAt,
        labels: obj.labels,
      });
  }
  async updateIssue(ref: IssueRef, patch: IssuePatch) {
    const obj = this.object(ref, 'issue');
    Object.assign(obj, structuredClone(patch));
    this.changed(obj);
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
    const obj = this.object(ref);
    if (this.recover(c.commandId, 'comment')) return;
    const now = this.nowMs(),
      mine = (s: StoredComment) => s.body.includes(marker(c.commandId));
    if (obj.comments.some((s) => s.listedAt <= now && mine(s))) return;
    this.addComment(obj, `${body}\n\n${marker(c.commandId)}`, VIEWER);
    const commentIds = obj.comments.filter(mine).map((s) => s.id);
    if (commentIds.length > 1)
      this.emit({
        ...this.envelope(),
        type: 'object.duplicate',
        commandId: c.commandId,
        kind: 'comment',
        target: structuredClone(obj.ref),
        commentIds,
      });
    this.changed(obj);
    this.created('comment', c.commandId);
  }
  /** Test-only: a comment written by hand (no marker unless the body has one). */
  addExternalComment(ref: IssueRef | PrRef, body: string, author = VIEWER) {
    const obj = this.object(ref);
    this.addComment(obj, body, author);
    this.changed(obj);
  }
  async deleteComment(target: IssueRef | PrRef, commentId: string) {
    const obj = this.object(target),
      index = obj.comments.findIndex((s) => s.id === commentId);
    if (index < 0) return;
    const found = obj.comments[index]!;
    if (found.author !== VIEWER || !anyMarker.test(found.body))
      fail('guard', 'comment_delete_guard');
    obj.comments.splice(index, 1);
    this.changed(obj);
  }
  async setLabels(ref: IssueRef | PrRef, labels: string[]) {
    const obj = this.object(ref);
    obj.labels = [...new Set(labels)];
    this.changed(obj);
  }
  async openPR(repo: RepoScmRef, draft: PrDraft, c: Correlation) {
    this.check(repo);
    const heads = await this.remote.heads();
    if (!heads.has(draft.head) || !heads.has(draft.base))
      fail('permanent', 'branch_not_found');
    const obj = this.create(draft, 'pr', c);
    if (!obj.headSha) {
      obj.headSha = heads.get(draft.head)!;
      this.prState(obj);
      this.emit({
        ...this.envelope(),
        type: 'pr.checks',
        pr: obj.ref,
        status: 'none',
      });
    }
    return {
      ...structuredClone(obj.ref),
      url: this.url(obj),
      head: obj.head,
      base: obj.base,
    };
  }
  private prState(obj: ObjectState) {
    this.emit({
      ...this.envelope(),
      type: 'pr.state',
      pr: obj.ref,
      state: obj.state,
      base: obj.base,
      head: obj.head,
      headSha: obj.headSha,
      mergeable: null,
      ...(obj.mergeCommitSha
        ? { mergeCommitSha: obj.mergeCommitSha, mergedBy: VIEWER }
        : {}),
    });
  }
  async updatePR(ref: PrRef, patch: PrPatch) {
    const obj = this.object(ref, 'pr');
    if (obj.state === 'merged') fail('conflict', 'pr_merged');
    Object.assign(obj, patch);
    this.changed(obj);
  }
  async getPR(ref: PrRef) {
    const obj = this.object(ref, 'pr');
    const headSha =
      obj.state === 'open'
        ? ((await this.remote.heads()).get(obj.head) ?? obj.headSha)
        : obj.headSha;
    return {
      state: obj.state,
      ...(obj.mergeCommitSha ? { mergeCommitSha: obj.mergeCommitSha } : {}),
      headSha,
      base: obj.base,
      ...(obj.mergeCommitSha ? { mergedBy: VIEWER } : {}),
    };
  }
  /** Test-only: moves the PR's base now, or during its next merge. */
  async retargetExternally(
    ref: PrRef,
    base: string,
    when: 'now' | 'during-next-merge' = 'now',
  ): Promise<void> {
    const obj = this.object(ref, 'pr');
    if (!(await this.remote.heads()).has(base))
      fail('permanent', 'branch_not_found');
    if (when === 'during-next-merge') {
      this.retargets.set(obj.ref.number, base);
      return;
    }
    obj.base = base;
    this.changed(obj);
  }
  async mergePR(
    ref: PrRef,
    opts: {
      method: 'merge';
      expectedHeadSha: string;
      expectedBaseSha?: string;
    },
  ) {
    const obj = this.object(ref, 'pr');
    // The PR's actual base decides; guard() refuses the default branch too.
    this.remote.guard(obj.base);
    this.remote.guard(obj.head);
    return this.remote.serial(async () => {
      if (obj.mergeCommitSha && obj.headSha === opts.expectedHeadSha)
        return { mergeCommitSha: obj.mergeCommitSha };
      if (obj.state !== 'open') fail('conflict', 'pr_not_open');
      const read = obj.base;
      let heads = await this.remote.heads();
      const head = heads.get(obj.head);
      if (!head || !heads.get(read) || head !== opts.expectedHeadSha)
        fail('conflict', 'head_mismatch');
      if (
        opts.expectedBaseSha !== undefined &&
        heads.get(read) !== opts.expectedBaseSha
      )
        fail('conflict', 'base_moved');
      // Like GitHub, the merge goes into whatever base the PR has by now.
      const retarget = this.retargets.get(obj.ref.number);
      if (retarget !== undefined) {
        this.retargets.delete(obj.ref.number);
        obj.base = retarget;
        heads = await this.remote.heads();
      }
      const base = heads.get(obj.base);
      if (!base) fail('conflict', 'base_missing');
      await this.remote.own(obj.base);
      await this.remote.fetch();
      await git(this.remote.path, ['checkout', '--detach', '--force', base]);
      try {
        await git(this.remote.path, ['merge', '--no-ff', '--no-edit', head]);
      } catch (error) {
        await git(this.remote.path, ['reset', '--hard', base]);
        throw error;
      }
      const sha = await git(this.remote.path, ['rev-parse', 'HEAD']);
      if ((await this.remote.heads()).get(obj.head) !== head)
        fail('conflict', 'head_mismatch');
      await this.remote.push(obj.base, sha, base);
      obj.headSha = head;
      obj.mergeCommitSha = sha;
      obj.state = 'merged';
      this.changed(obj);
      if (obj.base !== read) fail('guard', 'merge_base_changed');
      return { mergeCommitSha: sha };
    });
  }
  /**
   * T17's explicit fake final-PR merge (the owner's click): flips only this
   * in-memory PR to merged at its current head. Nothing is pushed, so the
   * protected default branch is never written.
   */
  simulateOwnerMerge(ref: PrRef): void {
    const obj = this.object(ref, 'pr');
    if (obj.state !== 'open') fail('conflict', 'pr_not_open');
    if (obj.base !== this.defaultBranch) fail('guard', 'not_final_pr');
    obj.mergeCommitSha = obj.headSha;
    obj.state = 'merged';
    this.changed(obj);
  }
  /** A list scan: lagging objects are invisible; the lowest match is kept. */
  private scan(commandId: string, hint: MarkerHint = {}): MarkerMatch | null {
    const now = this.nowMs(),
      from =
        hint.since === undefined
          ? -Infinity
          : Date.parse(hint.since) - MARKER_SCAN_SLACK_MS,
      listed = (at: number, time: string) =>
        at <= now && Date.parse(time) >= from,
      objects = [...this.objects.values()];
    const bodies = objects.filter(
      (o) =>
        (hint.kind === undefined || hint.kind === o.kind) &&
        listed(o.listedAt, o.updatedAt) &&
        o.body.includes(marker(commandId)),
    );
    if (bodies.length)
      return {
        ...structuredClone(bodies[0]!.ref),
        kind: bodies[0]!.kind,
        url: this.url(bodies[0]!),
        ...(bodies.length > 1 ? { duplicates: bodies.length - 1 } : {}),
      };
    if (hint.kind !== undefined && hint.kind !== 'comment') return null;
    const comments = objects
      .flatMap((obj) =>
        obj.comments
          .filter(
            (s) =>
              listed(s.listedAt, s.createdAt) &&
              s.body.includes(marker(commandId)),
          )
          .map((s) => ({ obj, id: s.id })),
      )
      .sort((a, b) => Number(a.id) - Number(b.id));
    const [keeper] = comments;
    if (!keeper) return null;
    return {
      ...structuredClone(keeper.obj.ref),
      kind: 'comment',
      url: `${this.url(keeper.obj)}#issuecomment-${keeper.id}`,
      commentId: keeper.id,
      ...(comments.length > 1 ? { duplicates: comments.length - 1 } : {}),
    };
  }
  async findByMarker(repo: RepoScmRef, commandId: string, hint?: MarkerHint) {
    this.check(repo);
    return this.scan(commandId, hint);
  }
  async listReviewComments(ref: PrRef): Promise<ReviewComment[]> {
    return structuredClone(this.object(ref, 'pr').reviews);
  }
  addReviewComment(ref: PrRef, review: ReviewComment): void {
    this.object(ref, 'pr').reviews.push(structuredClone(review));
  }
  async poll(repo: RepoScmRef, cursor: ScmCursor | null) {
    this.check(repo);
    const prefix = `gitremote:${repo.owner}/${repo.name}:`;
    const offset = cursor === null ? 0 : Number(cursor.slice(prefix.length));
    if (
      (cursor !== null && !cursor.startsWith(prefix)) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > this.events.length
    )
      fail('validation', 'invalid_cursor');
    const heads = await this.remote.heads();
    for (const [branch, sha] of heads) {
      if (branch !== this.defaultBranch && !this.tracked(branch)) continue;
      const previousSha = this.refs.get(branch) ?? null;
      if (previousSha === sha) continue;
      this.refs.set(branch, sha);
      this.emit({
        ...this.envelope(),
        type: 'branch.head_changed',
        branch,
        sha,
        previousSha,
      });
    }
    for (const branch of this.refs.keys())
      if (!heads.has(branch)) this.refs.delete(branch);
    for (const obj of this.objects.values())
      if (
        obj.kind === 'pr' &&
        obj.state === 'open' &&
        obj.headSha !== (heads.get(obj.head) ?? '')
      ) {
        obj.headSha = heads.get(obj.head) ?? '';
        this.prState(obj);
      }
    return {
      events: structuredClone(this.events.slice(offset)),
      cursor: ScmCursorSchema.parse(`${prefix}${this.events.length}`),
    };
  }
}
export const createGitRemoteScm = GitRemoteScm.create;
