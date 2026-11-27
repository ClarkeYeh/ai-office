import type { CommandResult } from '@ai-office/contracts/events';
import type { AgentKind } from './refs.js';
import type {
  RepoRuntimeRef,
  SessionRef,
  AgentRef,
  WorkspaceRef,
  QuestionRef,
  RuntimeCursor,
} from './refs.js';
import type { RuntimeEvent } from './runtime-events.js';
import { PortError } from './errors.js';
export type RuntimeWarning =
  | 'codex_env_filtered'
  | 'shim_folder_fallback'
  | 'version_changed'
  | 'host_slept'
  | 'orphan_resources'
  | 'chat_worker_identity_degraded';

export type RuntimeHealth = {
  binPath?: string;
  supportedRange?: string;
  shimLocation?: string;
  cliCallsPerMinute?: number;
  /** Per Orca subcommand over the last minute (FX-STATUS-CADENCE probe). */
  cliCommands?: Record<string, { calls: number; p50Ms: number; p95Ms: number }>;
  cpuSecondsPerMinute?: number;
  warnings?: RuntimeWarning[];
  available: boolean;
  version: string;
  verified: boolean;
  shim: 'ready' | 'missing';
  ownership: 'owned' | 'hijacked' | 'none';
};

export type Correlation = {
  workflowId: string;
  attemptId?: string;
  commandId: string;
}; // commandId 會寫入外部標記 aio:<commandId>

/**
 * The external-marker rule every runtime enforces before a marked mutation
 * (Orca writes `aio:<tag>` into whitespace-split text): no empty id and no
 * whitespace. The fake applies it too, so CI catches ids Orca would refuse.
 */
export function assertMarkerCommandId(commandId: string): void {
  if (!commandId || /\s/.test(commandId))
    throw new PortError(
      'guard',
      'invalid_command_marker',
      'Runtime safety check failed',
    );
}

export type WorkspaceReq =
  | { kind: 'new-worktree'; baseBranch: string; name: string; branch: string } // Orca：worktree create --branch，再 worker-start --worktree path:
  | { kind: 'existing-worktree'; workspace: WorkspaceRef; readOnly: boolean }; // 會議共用；Orca 不強制唯讀

/** One `kind: git` Orca repo with the cheap parts of `inspectLocalRepo`. */
export type LocalRepo = {
  path: string;
  displayName: string;
  runtimeRepoId: string;
  isGitMainWorktree: boolean;
  originUrl: string | null;
};

export type PreparedWorkspace = {
  workspace: WorkspaceRef;
  path: string;
  /** The pinned commit actually used to create this workspace. */
  baseSha?: string;
};

export interface RuntimePort {
  /** Request receipt lookup; absence is not proof the mutation did not happen. */
  inspectRequest(
    requestId: string,
    commandId: string,
  ): Promise<
    | { status: 'pending' | 'absent' }
    | { status: 'completed'; result: CommandResult }
  >;
  /**
   * Optional (FX-STATUS-LATENCY): the runtime signals that a session has
   * news, e.g. mail arrived on its long poll, so the caller observes it now
   * instead of at the next tick. Returns an unsubscribe.
   */
  onWake?(listener: (session: SessionRef) => void): () => void;
  /** Search durable aio: markers even after request receipts were pruned. */
  findCommandByMarker(commandId: string): Promise<CommandResult | null>;
  /** Find by deterministic name; reject a mismatching aio: comment. */
  findWorkspace(req: {
    repo: RepoRuntimeRef;
    name: string;
    commandId: string;
  }): Promise<PreparedWorkspace | null>;
  capabilities(): RuntimeCapabilities;
  health(): Promise<RuntimeHealth>; // 含版本、verified/unverified、shim 狀態、run 擁有權
  openSession(req: {
    workflowId: string;
    repo: RepoRuntimeRef;
    objective: string;
    correlation: Correlation;
  }): Promise<SessionRef>;
  /** Explicit user-authorized run-use; idempotent and without a request ID. */
  reclaimSession(session: SessionRef): Promise<{ reclaimed: boolean }>;
  closeSession(session: SessionRef): Promise<void>;
  prepareWorkspace(req: {
    session: SessionRef;
    repo: RepoRuntimeRef;
    /** Implement dispatch supplies the SHA resolved by ScmPort.compareBranch. */
    baseBranch: string;
    /** Fetch origin/<fetchBranch> before creating the workspace at baseSha. */
    fetchBranch?: string | undefined;
    baseSha?: string | undefined;
    /** Fetch branch and check out its pinned head in a fresh, caller-named -r<n> worktree. */
    checkoutExisting?: true | undefined;
    name: string;
    branch: string;
    correlation: Correlation;
  }): Promise<PreparedWorkspace>;
  disposeWorkspace(ws: WorkspaceRef): Promise<void>;
  spawnAgent(req: {
    session: SessionRef;
    agent: AgentKind;
    model?: string;
    effort?: 'low' | 'medium' | 'high';
    title: string;
    prompt: string;
    workspace: WorkspaceReq;
    correlation: Correlation;
    keepOpen: boolean; // 多回合角色為 true（§7.1）；Orca：worker-start --keep-open
  }): Promise<AgentRef>;
  /**
   * M5 §4.2: the worktree a `new-worktree` spawn created, read from adapter
   * state after `spawnAgent` resolved (sync, no runtime call). Optional so
   * older adapters and test doubles need no change; `AgentRef` is a branded
   * string, so the spawn result itself cannot carry it.
   */
  spawnedWorkspace?(commandId: string): WorkspaceRef | undefined;
  send(
    agent: AgentRef,
    msg: { subject: string; body: string; correlation: Correlation },
  ): Promise<void>;
  answer(
    question: QuestionRef,
    body: string,
    correlation: Correlation,
  ): Promise<void>;
  stop(agent: AgentRef): Promise<void>;
  release(agent: AgentRef, opts: { removeWorkspace: boolean }): Promise<void>;
  observe(
    session: SessionRef,
    cursor: RuntimeCursor | null,
  ): Promise<{ events: RuntimeEvent[]; cursor: RuntimeCursor }>;
  /** @deprecated Reconcile with inspectRequest and findCommandByMarker instead. */
  findByCorrelation(
    session: SessionRef,
    commandId: string,
  ): Promise<AgentRef | SessionRef | null>;
  resolveCaller(identity: {
    terminalHandle: string;
    paneKey?: string;
  }): Promise<AgentRef | null>;
  inspectLocalRepo(localPath: string): Promise<{
    isGitMainWorktree: boolean;
    originUrl: string | null;
    runtimeRepoId: string | null;
  }>; // Repo 註冊（§17.3）
  /**
   * v0.1.1 repo picker, read-only: the runtime's git repos (folder
   * workspaces excluded). Adapters may cache briefly; nothing is persisted.
   */
  listLocalRepos(): Promise<LocalRepo[]>;
  inspectWorkspace(
    ws: WorkspaceRef,
  ): Promise<{ clean: boolean; changedFiles: string[] }>; // 會議結束的乾淨檢查（§7.2），只回檔名
}

export type RuntimeCapabilities = {
  sharedWorkspace: boolean; // Orca：true（M0.5）
  exactBranchNaming: boolean; // Orca：true（經 worktree create --branch）
  structuredTranscript: boolean; // Orca：true（worker-read --source transcript）
  correlationSearch: boolean; // Orca：true（request-show、task-list title）
  callerChosenRequestId: boolean; // Orca：true（--retry-request 第一次即可帶自產 UUID）
};
// SessionRef / AgentRef / WorkspaceRef / QuestionRef / RuntimeCursor 皆為 opaque（branded string 或 JSON），application 不解讀

/** Smallest gap between runtime passes, so a slow pass never spins. */
export const RUNTIME_MIN_GAP_MS = 250;
/**
 * The runtime pass cadence (FX-STATUS-LATENCY), shared with the live latency
 * probe: at once after a wake, else a fixed rate from the previous pass's
 * start, never closer than the minimum gap.
 */
export function runtimeDelayMs(pass: {
  woken: boolean;
  intervalMs: number;
  startedAt: number | undefined;
  now: number;
}): number {
  if (pass.woken) return 0;
  if (pass.startedAt === undefined) return pass.intervalMs;
  return Math.max(
    RUNTIME_MIN_GAP_MS,
    pass.intervalMs - (pass.now - pass.startedAt),
  );
}
