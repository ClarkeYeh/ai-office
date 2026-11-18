import type { AgentSubmission } from '@ai-office/contracts/agent-submission';
import type { AgentRef, SessionRef, WorkspaceRef } from '../../ports/refs.js';
import type { RawBlock } from '../../ports/runtime-events.js';
import type { RuntimePort } from '../../ports/runtime.js';

type SpawnRequest = Parameters<RuntimePort['spawnAgent']>[0];
type ScenarioContext = {
  agent: AgentRef;
  session: SessionRef;
  workspace: WorkspaceRef;
  request: SpawnRequest;
  /** The spec file the agent read at spawn, when `readSpec` is injected. */
  spec?: string;
  message?: { subject: string; body: string };
  turn: number;
};
type ScenarioAction =
  | { type: 'submit'; submission: AgentSubmission }
  | { type: 'ask'; body: string }
  | { type: 'done'; outcome?: 'success' | 'failure'; filesModified?: number }
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
type ScenarioStep = ScenarioAction & { afterMs?: number };
type ScenarioScript =
  | readonly ScenarioStep[]
  | ((context: ScenarioContext) => readonly ScenarioStep[]);
type RoleBehavior = {
  spawn?: ScenarioScript;
  send?: ScenarioScript;
  answer?: ScenarioScript;
  ignoreStop?: boolean;
};
type RuntimeScenario = {
  /** Defaults to request.title; a selector can read the prompt or the spec the agent read. */
  role?: (request: SpawnRequest, spec?: string) => string;
  roles: Readonly<Record<string, RoleBehavior>>;
};
type FakeSubmission = {
  agent: AgentRef;
  terminalHandle: string;
  paneKey: string;
  seatToken: string;
  submission: AgentSubmission;
};
type FakePush = {
  agent: AgentRef;
  workspace: WorkspaceRef;
  /** The workspace's branch when prepared by the fake; else the scenario's. */
  branch: string;
  headSha: string;
  /** Commit the workspace was created from, for creating a new remote branch. */
  base?: string;
};
type Submitter = (request: FakeSubmission) => void | Promise<void>;
type PushHandler = (request: FakePush) => void | Promise<void>;

// Baseline copied from the public M2-T12 input. Changes require M4 coordination.
import { expectTypeOf, it } from 'vitest';
import type * as Current from './scenario.js';
import { createFakeRuntime } from './index.js';
import { createFakeScm } from '../scm-fake/index.js';
import { createFakeUsage } from '../usage-fake/index.js';
import type { Clock } from '../../ports/services.js';
import {
  scenarioWith,
  acceptanceWorld,
  office,
} from '../../acceptance/test-support/harness.js';
import type {
  Office,
  RuntimeIntercept,
} from '../../acceptance/test-support/harness.js';
import { createFakeWorld } from '../../main.js';
import type { FakeWorld, StartOptions } from '../../main.js';

it('locks the M4 scenario DSL and factory/harness call signatures', () => {
  expectTypeOf<Current.SpawnRequest>().toEqualTypeOf<SpawnRequest>();
  expectTypeOf<Current.ScenarioContext>().toEqualTypeOf<ScenarioContext>();
  expectTypeOf<Current.ScenarioAction>().toEqualTypeOf<ScenarioAction>();
  expectTypeOf<Current.ScenarioStep>().toEqualTypeOf<ScenarioStep>();
  expectTypeOf<Current.ScenarioScript>().toEqualTypeOf<ScenarioScript>();
  expectTypeOf<Current.RoleBehavior>().toEqualTypeOf<RoleBehavior>();
  expectTypeOf<Current.RuntimeScenario>().toEqualTypeOf<RuntimeScenario>();
  expectTypeOf<Current.FakeSubmission>().toEqualTypeOf<FakeSubmission>();
  expectTypeOf<Current.FakePush>().toEqualTypeOf<FakePush>();
  expectTypeOf<Current.Submitter>().toEqualTypeOf<Submitter>();
  expectTypeOf<Current.PushHandler>().toEqualTypeOf<PushHandler>();
  expectTypeOf<Parameters<typeof createFakeRuntime>>().toEqualTypeOf<
    [
      options: {
        clock: Clock;
        scenario?: RuntimeScenario;
        submitter?: Submitter;
        onPush?: PushHandler;
        localRepos?: Readonly<
          Record<string, Awaited<ReturnType<RuntimePort['inspectLocalRepo']>>>
        >;
        readSpec?: (path: string, sha256: string) => string | null;
        remoteHead?: (ref: string) => Promise<string | null> | string | null;
        submitRetryMs?: number;
      },
    ]
  >();
  expectTypeOf<Parameters<typeof createFakeScm>>().toEqualTypeOf<
    [
      options?: {
        clock?: Clock;
        mergeDelayMs?: number;
        delay?: (ms: number) => Promise<void>;
        autoMergeIntoDefaultBranchAfterMs?: number;
      },
    ]
  >();
  expectTypeOf<Parameters<typeof createFakeUsage>>().toEqualTypeOf<
    [options?: { source?: 'session-log' | 'none'; clock?: Clock }]
  >();
  expectTypeOf(scenarioWith).toEqualTypeOf<
    (overrides?: Readonly<Record<string, RoleBehavior>>) => RuntimeScenario
  >();
  expectTypeOf(acceptanceWorld).toEqualTypeOf<
    (
      dataDir: string,
      scenario: RuntimeScenario,
      options?: {
        finalMergeMs?: number;
        intercept?: RuntimeIntercept;
        scmIntercept?: RuntimeIntercept;
        mergeDelay?: (ms: number) => Promise<void>;
      },
    ) => FakeWorld
  >();
  expectTypeOf(office).toEqualTypeOf<
    (options?: {
      scenario?: RuntimeScenario;
      roles?: Readonly<Record<string, RoleBehavior>>;
      home?: string;
      world?: FakeWorld;
      finalMergeMs?: number;
      intercept?: RuntimeIntercept;
      scmIntercept?: RuntimeIntercept;
      mergeDelay?: (ms: number) => Promise<void>;
    }) => Promise<Office>
  >();
  expectTypeOf(createFakeWorld).toEqualTypeOf<
    (
      scenario: string,
      options: {
        readSpec: (path: string, sha256: string) => string | null;
        finalMergeMs?: number;
      },
    ) => FakeWorld
  >();
  expectTypeOf<StartOptions['fakeFinalMergeMs']>().toEqualTypeOf<
    number | undefined
  >();
});
