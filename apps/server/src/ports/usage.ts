import type { AgentKind } from './refs.js';
import type { UsageCursor } from './refs.js';
export interface UsagePort {
  capabilities(): {
    source: 'session-log' | 'none';
    agents: AgentKind[];
    formatVerified: boolean;
  };
  locate(ref: UsageLocateRef): Promise<UsageRef | null>; // 依優先順序找 session 紀錄
  read(
    ref: UsageRef,
    cursor: UsageCursor | null,
  ): Promise<{ samples: UsageSample[]; cursor: UsageCursor }>;
}
export type UsageLocateRef = {
  attemptId: string;
  agent: AgentKind;
  reportedSessionId?: string;
  dispatchId: string;
  /** Attempt start (ISO timestamp), used to bound session-log fallback searches. */
  startedAt?: string;
  transcriptMessageIds?: string[];
};
export type UsageRef = {
  attemptId: string;
  agent: AgentKind;
  sessionId: string;
  file: string;
};
export type UsageSample = {
  externalKey: string; // claude: usage:<sessionId>:<message.id>; codex: usage:codex:<threadId>:<total>
  occurredAt: string;
  inputUncached: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  cumulative: boolean; // Codex 為累計值，application 以差值入帳
};
