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
  message?: { subject: string; body: string };
  turn: number;
};
export type ScenarioAction =
  | { type: 'submit'; submission: AgentSubmission }
  | { type: 'ask'; body: string }
  | { type: 'done'; outcome?: 'success' | 'failure'; filesModified?: number }
  | { type: 'push'; branch: string; headSha: string }
  | { type: 'output'; blocks: RawBlock[] }
  | { type: 'lost' }
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
};
export type RuntimeScenario = {
  /** Defaults to request.title; a selector can read the application's prompt/role convention. */
  role?: (request: SpawnRequest) => string;
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
  branch: string;
  headSha: string;
};
export type Submitter = (request: FakeSubmission) => void | Promise<void>;
export type PushHandler = (request: FakePush) => void | Promise<void>;
