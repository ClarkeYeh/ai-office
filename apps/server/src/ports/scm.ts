import type { ExternalCommand } from '@ai-office/contracts/events';
import type { RepoScmRef, IssueRef, PrRef, ScmCursor } from './refs.js';
import type { Correlation } from './runtime.js';
import type { ScmEvent } from './scm-events.js';
type Args<K extends ExternalCommand['kind']> = Extract<
  ExternalCommand,
  { kind: K }
>['args'];
export type LabelSpec = Args<'scm.ensureLabels'>['labels'][number];
export type IssueDraft = Omit<Args<'scm.createIssue'>, 'repo'>;
export type IssuePatch = Args<'scm.updateIssue'>['patch'];
export type PrDraft = Omit<Args<'scm.openPR'>, 'repo'>;
export type PrPatch = Args<'scm.updatePR'>['patch'];
export type ReviewComment = {
  id: string;
  author: string;
  body: string;
  path: string;
  line: number | null;
  occurredAt: string;
};
export type ScmHealth = {
  available: boolean;
  viewerLogin: string | null;
  rateLimitRemaining: number;
  rateLimitResetAt: string;
};
export interface ScmPort {
  health(): Promise<ScmHealth>; // 登入者、rate limit 餘量
  inspectRepo(repo: RepoScmRef): Promise<{
    defaultBranch: string;
    visibility: 'public' | 'private';
    defaultBranchProtected: boolean | 'unknown';
    viewerLogin: string;
  }>;
  ensureLabels(repo: RepoScmRef, labels: LabelSpec[]): Promise<void>;
  ensureBranch(
    repo: RepoScmRef,
    name: string,
    from: string,
    c: Correlation,
  ): Promise<void>;
  deleteBranch(repo: RepoScmRef, name: string): Promise<void>; // 拒絕預設分支與非 ai-office/ 前綴
  compareBranch(
    repo: RepoScmRef,
    base: string,
    head: string,
  ): Promise<{ ahead: number; headSha: string } | null>;
  createIssue(
    repo: RepoScmRef,
    d: IssueDraft,
    c: Correlation,
  ): Promise<IssueRef>; // body 附 <!-- ai-office:cmd=<commandId> -->
  getIssue(ref: IssueRef): Promise<{
    body: string;
    bodyHash: string;
    updatedAt: string;
    labels: string[];
  }>; // 結論核准時讀取當下版本
  updateIssue(ref: IssueRef, patch: IssuePatch): Promise<void>;
  comment(ref: IssueRef | PrRef, body: string, c: Correlation): Promise<void>;
  setLabels(ref: IssueRef | PrRef, labels: string[]): Promise<void>;
  openPR(repo: RepoScmRef, d: PrDraft, c: Correlation): Promise<PrRef>;
  updatePR(ref: PrRef, patch: PrPatch): Promise<void>;
  mergePR(
    ref: PrRef,
    opts: { method: 'merge'; expectedHeadSha: string },
  ): Promise<{ mergeCommitSha: string }>;
  // 硬規則：base 為預設分支一律拒絕（ScmGuardError）
  findByMarker(
    repo: RepoScmRef,
    commandId: string,
  ): Promise<IssueRef | PrRef | null>;
  listReviewComments(pr: PrRef): Promise<ReviewComment[]>;
  poll(
    repo: RepoScmRef,
    cursor: ScmCursor | null,
  ): Promise<{ events: ScmEvent[]; cursor: ScmCursor }>; // ETag 條件請求
}
