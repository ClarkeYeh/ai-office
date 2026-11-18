import type { AgentSubmission } from '@ai-office/contracts/agent-submission';
import type { AgentRef, SessionRef, WorkspaceRef } from '../../ports/refs.js';
import type { RawBlock } from '../../ports/runtime-events.js';
import type { RuntimePort } from '../../ports/runtime.js';

export type SpawnRequest = Parameters<RuntimePort['spawnAgent']>[0];
export type ScenarioContext = {
  agent: AgentRef;
  session: SessionRef;
  workspace: WorkspaceRef;
  request: SpawnRequest;
  /** The spec file the agent read at spawn, when `readSpec` is injected. */
  spec?: string;
  message?: { subject: string; body: string };
  turn: number;
};
export type ScenarioAction =
  | { type: 'submit'; submission: AgentSubmission }
  | { type: 'ask'; body: string }
  | {
      type: 'done';
      outcome?: 'success' | 'failure';
      filesModified?: number;
      /**
       * Real Orca (M2-T17 D5): a keep-open worker's next worker-list poll
       * reports it `idle` this many ms after worker_done. Off when absent.
       */
      idleAfterMs?: number;
    }
  | { type: 'push'; branch: string; headSha: string }
  | { type: 'output'; blocks: RawBlock[] }
  | { type: 'lost' }
  | {
      type: 'rate-limited';
      evidence: 'worker-show' | 'transcript';
      resetsAt?: string;
    }
  | {
      type: 'degraded';
      reason: 'source_changed' | 'no_transcript_source' | 'transcript_clipped';
    }
  | { type: 'duplicate' }
  | { type: 'unmanaged'; dispatch: string }
  | { type: 'policy'; command: string }
  | { type: 'false-escalation' }
  | { type: 'turn-start-unobserved' };
/** Delays are relative to the trigger, not the preceding step. Equal times retain DSL order. */
export type ScenarioStep = ScenarioAction & { afterMs?: number };
export type ScenarioScript =
  | readonly ScenarioStep[]
  | ((context: ScenarioContext) => readonly ScenarioStep[]);
export type RoleBehavior = {
  spawn?: ScenarioScript;
  send?: ScenarioScript;
  answer?: ScenarioScript;
  ignoreStop?: boolean;
  /**
   * Spawned but never acts on any trigger: no output, submission, push or done
   * (the §7.1 spawn-stall case). Stop and release still end it.
   */
  silent?: boolean;
  /**
   * Real Orca (M2-T17 D8): a stop settles this many ms later; a release
   * arriving before then fails transiently (the adapter's
   * `release_pending_stop`) and is retried. Off when absent.
   */
  stopSettleMs?: number;
};
export type RuntimeScenario = {
  /** Defaults to request.title; a selector can read the prompt or the spec the agent read. */
  role?: (request: SpawnRequest, spec?: string) => string;
  roles: Readonly<Record<string, RoleBehavior>>;
};
export type FakeSubmission = {
  agent: AgentRef;
  terminalHandle: string;
  paneKey: string;
  seatToken: string;
  submission: AgentSubmission;
};
export type FakePush = {
  agent: AgentRef;
  workspace: WorkspaceRef;
  /** The workspace's branch when prepared by the fake; else the scenario's. */
  branch: string;
  headSha: string;
  /** Commit the workspace was created from, for creating a new remote branch. */
  base?: string;
};
export type Submitter = (request: FakeSubmission) => void | Promise<void>;
export type PushHandler = (request: FakePush) => void | Promise<void>;
