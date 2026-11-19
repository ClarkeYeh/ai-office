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
  tokenSource?: 'env' | 'gh'; // PP5: never the token itself
  warnings?: string[];
};
/** PP1: where a command marker was found; `url` is the real `html_url`. */
export type MarkerMatch = (IssueRef | PrRef) & {
  kind: 'issue' | 'pr' | 'comment';
  url: string;
  commentId?: string;
  /** Further objects carrying the same marker; the match is the keeper (§4.8). */
  duplicates?: number;
};
export type MarkerHint = {
  /** ISO time the command was first sent; scans start 10 minutes earlier. */
  since?: string;
  kind?: 'issue' | 'pr' | 'comment';
};
/** List scans may start this long before `MarkerHint.since` (clock skew). */
export const MARKER_SCAN_SLACK_MS = 10 * 60_000;
/**
 * After a create (Issue, comment) whose outcome is unknown, a marker scan that
 * finds nothing within this window answers `create_outcome_unknown` again
 * instead of creating a second object (SPEC §11.5). max(60 s, 3 × list lag p99).
 */
export const CREATE_PENDING_WINDOW_MS = 60_000;
/** The `retryAfterMs` of `create_outcome_unknown` (M3_PLAN §4.2). */
export const CREATE_RETRY_AFTER_MS = 15_000;
export interface ScmPort {
  getPR(ref: PrRef): Promise<{
    state: 'open' | 'closed' | 'merged';
    mergeCommitSha?: string;
    headSha: string;
    base: string;
    mergedBy?: string;
  }>;
  health(): Promise<ScmHealth>; // 登入者、rate limit 餘量；選填 tokenSource、warnings
  inspectRepo(repo: RepoScmRef): Promise<{
    defaultBranch: string;
    visibility: 'public' | 'private';
    defaultBranchProtected: boolean | 'unknown';
    viewerLogin: string;
    allowMergeCommit?: boolean;
    archived?: boolean;
    canPush?: boolean;
    warnings?: string[];
  }>;
  ensureLabels(repo: RepoScmRef, labels: LabelSpec[]): Promise<void>;
  ensureBranch(
    repo: RepoScmRef,
    name: string,
    from: string,
    c: Correlation,
  ): Promise<void>; // 只建立 ai-office/…；已存在 → 成功且不更新
  // 拒絕預設分支、非 ai-office/ 前綴與受保護分支；不存在 → 成功。刪除 head 分支會關閉 open PR
  deleteBranch(repo: RepoScmRef, name: string): Promise<void>;
  compareBranch(
    repo: RepoScmRef,
    base: string,
    head: string,
  ): Promise<{ ahead: number; headSha: string } | null>;
  createIssue(
    repo: RepoScmRef,
    d: IssueDraft,
    c: Correlation,
  ): Promise<IssueRef & { url: string }>;
  // body 附 <!-- ai-office:cmd=<commandId> -->。結果不明 → transient create_outcome_unknown＋retryAfterMs；
  // 以同一 commandId 重試時先以 marker 掃描，pending 視窗內找不到就再回 create_outcome_unknown（comment 同）
  getIssue(ref: IssueRef): Promise<{
    body: string;
    bodyHash: string;
    updatedAt: string;
    labels: string[];
  }>; // 結論核准時讀取當下版本
  updateIssue(ref: IssueRef, patch: IssuePatch): Promise<void>;
  comment(ref: IssueRef | PrRef, body: string, c: Correlation): Promise<void>;
  // PP7: only the viewer's comments carrying an AI Office marker; absent → success
  deleteComment(target: IssueRef | PrRef, commentId: string): Promise<void>;
  setLabels(ref: IssueRef | PrRef, labels: string[]): Promise<void>;
  openPR(
    repo: RepoScmRef,
    d: PrDraft,
    c: Correlation,
  ): Promise<PrRef & { url: string }>;
  updatePR(ref: PrRef, patch: PrPatch): Promise<void>;
  /**
   * Hard rule: judged by the PR's **actual** base, which must start with
   * `ai-office/` and differ from the default branch, else `guard`. Head
   * mismatch → `conflict`; `expectedBaseSha` ≠ the base's current SHA →
   * `conflict base_moved`. Already merged at the expected head → the same
   * merge commit. The PR is read again after merging: a base that changed
   * meanwhile → `guard merge_base_changed` (there is no atomic base lock).
   */
  mergePR(
    ref: PrRef,
    opts: {
      method: 'merge';
      expectedHeadSha: string;
      expectedBaseSha?: string;
    },
  ): Promise<{ mergeCommitSha: string }>;
  // 列表掃描（不用 Search API），精確比對 marker；多個符合時回保留者（最小編號）
  findByMarker(
    repo: RepoScmRef,
    commandId: string,
    hint?: MarkerHint,
  ): Promise<MarkerMatch | null>;
  listReviewComments(pr: PrRef): Promise<ReviewComment[]>;
  poll(
    repo: RepoScmRef,
    cursor: ScmCursor | null,
  ): Promise<{ events: ScmEvent[]; cursor: ScmCursor }>; // ETag 條件請求
}
