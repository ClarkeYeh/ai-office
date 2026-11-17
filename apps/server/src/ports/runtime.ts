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
export type RuntimeHealth = {
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

export type WorkspaceReq =
  | { kind: 'new-worktree'; baseBranch: string; name: string; branch: string } // Orca：worktree create --branch，再 worker-start --worktree path:
  | { kind: 'existing-worktree'; workspace: WorkspaceRef; readOnly: boolean }; // 會議共用；Orca 不強制唯讀

export interface RuntimePort {
  capabilities(): RuntimeCapabilities;
  health(): Promise<RuntimeHealth>; // 含版本、verified/unverified、shim 狀態、run 擁有權
  openSession(req: {
    workflowId: string;
    repo: RepoRuntimeRef;
    objective: string;
    correlation: Correlation;
  }): Promise<SessionRef>;
  closeSession(session: SessionRef): Promise<void>;
  prepareWorkspace(req: {
    session: SessionRef;
    repo: RepoRuntimeRef;
    baseBranch: string;
    name: string;
    branch: string;
    correlation: Correlation;
  }): Promise<WorkspaceRef>;
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
