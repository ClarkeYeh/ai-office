import type { RepoSnapshot } from '@ai-office/contracts/events';
import type { WorkflowTemplate } from '@ai-office/contracts/template';
import type {
  AttemptPurpose,
  OpenGate,
  StartWorkflow,
  WorkflowState,
} from '@ai-office/domain';
import { commandId, metaFor, sessionRef } from '../context.js';
import type { ReactContext } from '../context.js';
import { external, internal } from '../effects.js';
import type { Effect } from '../effects.js';
import { DEFAULT_MODULES } from '../react.js';
import type { EngineModules } from '../react.js';
import type { StageModule } from '../stages/types.js';

export const WORKFLOW_ID = 'wf-1';
export const HASH = 'a'.repeat(64);

/** The built-in feature-to-pr template, inlined (domain's fixtures are not exported). */
export const template = (): WorkflowTemplate => ({
  apiVersion: 'ai-office/v1alpha1',
  id: 'feature-to-pr',
  name: '需求到 PR',
  roles: {
    lead: { agent: 'claude-code', effort: 'high', scope: 'lead' },
    pm: { agent: 'claude-code' },
    architect: { agent: 'claude-code' },
    engineer: { agent: 'codex' },
    integrator: { agent: 'claude-code' },
  },
  defaults: {
    integrationBranch: 'ai-office/{shortId}-{slug}',
    maxReruns: 2,
    budget: { hardLimitMultiplier: 2 },
    workflowBudget: { tokens: 3_000_000 },
  },
  stages: [
    {
      id: 'meeting',
      kind: 'meeting',
      facilitator: 'lead',
      participants: ['pm', 'architect', 'engineer'],
      maxRounds: 2,
      timeouts: { roundMin: 15, stageMin: 60 },
      budget: { tokens: 300_000, maxTurns: 60 },
      conclusion: { requireTechDecisions: true },
      gate: { id: 'conclusion', title: '結論定案', optional: true },
    },
    {
      id: 'breakdown',
      kind: 'planning',
      owner: 'lead',
      from: 'meeting',
      timeouts: { stageMin: 30 },
      budget: { tokens: 200_000, maxTurns: 40 },
      gate: {
        id: 'task-split',
        title: '任務拆分',
        optional: true,
        editable: ['title', 'body', 'acceptance', 'role', 'agent', 'deps'],
      },
    },
    {
      id: 'implement',
      kind: 'implement',
      role: 'engineer',
      from: 'breakdown',
      maxParallel: 3,
      timeouts: { itemMin: 45 },
      budget: {
        tokens: 1_500_000,
        perItem: { tokens: 400_000, maxTurns: 120 },
      },
      onCall: { role: 'lead', questionTimeoutMin: 10 },
      mergeQueue: { role: 'integrator', reviewTimeoutMin: 20, maxRework: 2 },
      escalateOn: ['unresolvable-conflict', 'ci-failed-twice'],
    },
    {
      id: 'integrate',
      kind: 'integrate',
      owner: 'integrator',
      timeouts: { stageMin: 60 },
      budget: { tokens: 400_000, maxTurns: 100 },
    },
    {
      id: 'final-pr',
      kind: 'final-pr',
      maxRevisions: 2,
      gate: { id: 'final-pr', title: '最終 PR' },
    },
  ],
});

export const repo = (): RepoSnapshot => ({
  repoId: 'repo-1',
  localPath: '/repos/demo',
  orcaRepoId: 'orca-repo-1',
  github: { owner: 'octo', name: 'demo' },
  defaultBranch: 'main',
  visibility: 'public',
  ownerLogin: 'octo',
  defaultBranchProtected: true,
});

export const startWorkflow = (
  occurredAt = '2026-11-17T00:00:00.000Z',
): StartWorkflow => ({
  type: 'StartWorkflow',
  meta: { occurredAt, source: 'user' },
  workflowId: WORKFLOW_ID,
  shortId: 'ab12',
  template: template(),
  repo: repo(),
  requirement: 'Add dark mode toggle',
  limits: { globalAgents: 10 },
});

export interface SpawnSpec {
  attemptId: string;
  role: string;
  stageId: string;
  purpose: AttemptPurpose;
}

/** SpawnAttempt + `runtime.spawnAgent` sharing a deterministic command id. */
export const spawnEffects = (ctx: ReactContext, spec: SpawnSpec): Effect[] => {
  const spawnCommandId = commandId(ctx, 'spawn', spec.attemptId);
  return [
    internal({
      type: 'SpawnAttempt',
      meta: metaFor(ctx),
      stageId: spec.stageId,
      role: spec.role,
      attemptId: spec.attemptId,
      purpose: spec.purpose,
      keepOpen: true,
      spawnCommandId,
    }),
    external(
      spawnCommandId,
      {
        kind: 'runtime.spawnAgent',
        args: {
          session: sessionRef(ctx.state) ?? 'no-session',
          agent: 'claude-code',
          title: `aio ${spec.attemptId}`,
          specPath: `/specs/${spec.attemptId}.md`,
          specSha256: HASH,
          workspace: {
            kind: 'new-worktree',
            baseBranch: 'main',
            name: `aio-ab12-${spec.attemptId}`,
            branch: `ai-office/ab12/${spec.attemptId}`,
          },
          keepOpen: true,
        },
      },
      { stageId: spec.stageId, attemptId: spec.attemptId },
    ),
  ];
};

/** A stage gate for `meeting`, as T13 would build it. */
export const conclusionGate = (
  _state: WorkflowState,
  stageId: string,
): OpenGate['gate'] => ({
  kind: 'stage',
  gateId: `${WORKFLOW_ID}/gate/conclusion`,
  stageId,
  templateGateId: 'conclusion',
  stageKind: 'meeting',
  optional: true,
  title: '結論定案',
  options: [],
  content: { type: 'conclusion', artifactId: 'art-1', renderedHash: HASH },
});

/** Default modules with the meeting partition replaced by a test probe. */
export const withMeeting = (meeting: StageModule): EngineModules => ({
  ...DEFAULT_MODULES,
  stages: { ...DEFAULT_MODULES.stages, meeting, planning: { react: () => [] } },
});
