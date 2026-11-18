import { createHash } from 'node:crypto';
import { PortError } from '../../../ports/errors.js';
import {
  ScmCursorSchema,
  type IssueRef,
  type PrRef,
  type RepoScmRef,
  type ScmCursor,
} from '../../../ports/refs.js';
import type { Correlation } from '../../../ports/runtime.js';
import type {
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
  comments: string[];
  reviews: ReviewComment[];
  updatedAt: string;
  mergeCommitSha?: string;
};
const marker = (id: string) => `<!-- ai-office:cmd=${id} -->`;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fail(
  category: 'guard' | 'conflict' | 'permanent' | 'validation',
  code: string,
): never {
  throw new PortError(category, code, `Test SCM: ${code}`);
}

/** Test-only SCM: real git history, in-memory GitHub objects. Never compose in production. */
export class GitRemoteScm implements ScmPort {
  private objects = new Map<number, ObjectState>();
  private labels = new Map<string, LabelSpec>();
  private events: ScmEvent[] = [];
  private constructor(
    private readonly remote: TestGitRemote,
    private readonly repo: RepoScmRef,
  ) {}
  static async create(
    options: GitRemoteOptions & { repo?: RepoScmRef },
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
    );
  }
  dispose(): Promise<void> {
    return this.remote.dispose();
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
      occurredAt: new Date().toISOString(),
    };
  }
  private url(obj: ObjectState) {
    return `https://github.com/${this.repo.owner}/${this.repo.name}/${obj.kind === 'pr' ? 'pull' : 'issues'}/${obj.ref.number}`;
  }
  async health() {
    return {
      available: true,
      viewerLogin: 'scm-test',
      rateLimitRemaining: 5000,
      rateLimitResetAt: new Date().toISOString(),
    };
  }
  async inspectRepo(repo: RepoScmRef) {
    this.check(repo);
    return {
      defaultBranch: this.remote.options.defaultBranch ?? 'main',
      visibility: 'public' as const,
      defaultBranchProtected: true,
      viewerLogin: 'scm-test',
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
    const previous = [...this.objects.values()].find(
      (o) => o.kind === kind && o.body.includes(marker(c.commandId)),
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
      updatedAt: new Date().toISOString(),
    };
    this.objects.set(obj.ref.number, obj);
    this.emit({
      ...this.envelope(),
      type: 'repo.object_created',
      ref: obj.ref,
      author: 'scm-test',
      hasMarker: true,
    });
    return obj;
  }
  async createIssue(repo: RepoScmRef, draft: IssueDraft, c: Correlation) {
    this.check(repo);
    const obj = this.create(draft, 'issue', c);
    return { ...structuredClone(obj.ref), url: this.url(obj) };
  }
  async getIssue(ref: IssueRef) {
    const obj = this.object(ref, 'issue');
    return {
      body: obj.body,
      bodyHash: hash(obj.body),
      updatedAt: obj.updatedAt,
      labels: [...obj.labels],
    };
  }
  private changed(obj: ObjectState) {
    obj.updatedAt = new Date().toISOString();
    if (obj.kind === 'pr') this.prState(obj);
    else
      this.emit({
        ...this.envelope(),
        type: 'issue.edited',
        issue: obj.ref,
        bodyHash: hash(obj.body),
        updatedAt: obj.updatedAt,
        labels: obj.labels,
      });
  }
  async updateIssue(ref: IssueRef, patch: IssuePatch) {
    const obj = this.object(ref, 'issue');
    Object.assign(obj, structuredClone(patch));
    this.changed(obj);
  }
  async comment(ref: IssueRef | PrRef, body: string, c: Correlation) {
    const obj = this.object(ref);
    if (!obj.comments.some((s) => s.includes(marker(c.commandId)))) {
      obj.comments.push(`${body}\n\n${marker(c.commandId)}`);
      this.changed(obj);
    }
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
        ? { mergeCommitSha: obj.mergeCommitSha, mergedBy: 'scm-test' }
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
    this.remote.guard(obj.base);
    this.remote.guard(obj.head);
    return this.remote.serial(async () => {
      if (obj.mergeCommitSha && obj.headSha === opts.expectedHeadSha)
        return { mergeCommitSha: obj.mergeCommitSha };
      if (obj.state !== 'open') fail('conflict', 'pr_not_open');
      const heads = await this.remote.heads();
      const head = heads.get(obj.head),
        base = heads.get(obj.base);
      if (!head || !base || head !== opts.expectedHeadSha)
        fail('conflict', 'head_mismatch');
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
      return { mergeCommitSha: sha };
    });
  }
  async findByMarker(repo: RepoScmRef, commandId: string) {
    this.check(repo);
    const obj = [...this.objects.values()].find((o) =>
      [o.body, ...o.comments].some((s) => s.includes(marker(commandId))),
    );
    return obj ? structuredClone(obj.ref) : null;
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
