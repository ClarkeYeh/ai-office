import { DomainEventSchema } from '@ai-office/contracts/events';
import type {
  DomainEvent,
  DomainEventDraft,
  EventPayload,
  EventType,
  RepoSnapshot,
} from '@ai-office/contracts/events';
import type { WorkflowTemplate } from '@ai-office/contracts/template';
import type { CommandMeta, DomainCommand, StartWorkflow } from '../commands.js';
import { decide } from '../decide/index.js';
import type { DecideResult } from '../errors.js';
import { evolveWithWarning } from '../evolve.js';
import type { EvolveWarning } from '../evolve.js';
import { initialState } from '../state/index.js';
import type { WorkflowState } from '../state/index.js';

export const WORKFLOW_ID = 'wf-1';
export const SHORT_ID = 'ab12';
export const T0 = Date.parse('2026-11-17T00:00:00.000Z');
export const at = (second: number): string =>
  new Date(T0 + second * 1000).toISOString();
export const HASH = 'a'.repeat(64);
export const SHA = 'abcdef1';

/** The built-in feature-to-pr template (packages/templates), inlined for domain tests. */
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
    },
    {
      id: 'integrate',
      kind: 'integrate',
      owner: 'integrator',
      escalateOn: ['unresolvable-conflict', 'ci-failed-twice'],
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

export const meta = (
  second = 0,
  source: CommandMeta['source'] = 'engine',
): CommandMeta => ({ occurredAt: at(second), source });

export const startCommand = (
  overrides: Partial<StartWorkflow> = {},
): StartWorkflow => ({
  type: 'StartWorkflow',
  meta: meta(0, 'user'),
  workflowId: WORKFLOW_ID,
  shortId: SHORT_ID,
  template: template(),
  repo: repo(),
  requirement: 'Add dark mode toggle',
  limits: { globalAgents: 10 },
  ...overrides,
});

/** Crockford-valid ULID derived from seq (digits only). */
export const ulidFor = (seq: number): string =>
  `01${String(seq).padStart(24, '0')}`;

export const toEvent = (draft: DomainEventDraft, seq: number): DomainEvent =>
  ({
    ...draft,
    seq,
    id: ulidFor(seq),
    recordedAt: draft.occurredAt,
  }) as DomainEvent;

export type Step = DomainCommand | DomainEventDraft;
const isDraft = (step: Step): step is DomainEventDraft => 'payload' in step;

/**
 * Event-sourced test driver: decide → schema-check → evolve, like WorkflowRunner.
 * Every emitted event must satisfy `DomainEventSchema` and evolve cleanly.
 */
export class Harness {
  state: WorkflowState = initialState();
  events: DomainEvent[] = [];
  warnings: EvolveWarning[] = [];

  append(...drafts: DomainEventDraft[]): DomainEvent[] {
    return drafts.map((draft) => {
      const event = toEvent(draft, this.events.length + 1);
      const result = evolveWithWarning(this.state, event);
      this.state = result.state;
      this.events.push(event);
      if (result.warning !== undefined) this.warnings.push(result.warning);
      return event;
    });
  }

  run(command: DomainCommand): DecideResult {
    const result = decide(this.state, command);
    if (result.ok) {
      for (const draft of result.events)
        DomainEventSchema.parse(toEvent(draft, 1));
      this.append(...result.events);
    }
    return result;
  }

  /** Runs steps that must all succeed without evolve warnings. */
  given(...steps: Step[]): this {
    for (const step of steps) {
      if (isDraft(step)) this.append(step);
      else {
        const result = this.run(step);
        if (!result.ok)
          throw new Error(`${step.type} failed: ${result.error.code}`);
      }
    }
    if (this.warnings.length > 0)
      throw new Error(`Unexpected warnings: ${JSON.stringify(this.warnings)}`);
    return this;
  }
}

/** A draft for a hand-written event (things outside T6's decide, e.g. gates). */
export const eventDraft = <T extends EventType>(
  type: T,
  payload: EventPayload<T>,
  extra: Partial<Pick<DomainEventDraft, 'attemptId' | 'stageId' | 'seatId'>> & {
    second?: number;
    workflowId?: string | null;
  } = {},
): DomainEventDraft =>
  ({
    type,
    payload,
    occurredAt: at(extra.second ?? 0),
    workflowId: extra.workflowId === undefined ? WORKFLOW_ID : extra.workflowId,
    ...(extra.stageId === undefined ? {} : { stageId: extra.stageId }),
    ...(extra.seatId === undefined ? {} : { seatId: extra.seatId }),
    ...(extra.attemptId === undefined ? {} : { attemptId: extra.attemptId }),
    source: 'engine',
    provenance: 'decided',
    schemaVersion: 1,
  }) as DomainEventDraft;

// Common command builders --------------------------------------------------

export const startStage = (stageId: string, second = 1): DomainCommand => ({
  type: 'StartStage',
  meta: meta(second),
  stageId,
});
export const completeStage = (
  stageId: string,
  attempt = 1,
  second = 2,
): DomainCommand => ({
  type: 'CompleteStage',
  meta: meta(second),
  stageId,
  attempt,
});
export const spawn = (
  attemptId: string,
  role: string,
  stageId = 'meeting',
  extra: Partial<Extract<DomainCommand, { type: 'SpawnAttempt' }>> = {},
): DomainCommand => ({
  type: 'SpawnAttempt',
  meta: meta(3),
  stageId,
  role,
  attemptId,
  purpose: 'participant',
  keepOpen: true,
  spawnCommandId: `cmd-${attemptId}`,
  ...extra,
});
export const observe = (
  attemptId: string,
  state: Extract<DomainCommand, { type: 'ObserveAttemptStatus' }>['state'],
): DomainCommand => ({
  type: 'ObserveAttemptStatus',
  meta: meta(4, 'runtime'),
  attemptId,
  state,
});
export const approveGate = (
  gateId: string,
  stageId: string,
  stageKind: 'meeting' | 'planning' | 'final-pr',
): DomainEventDraft[] => [
  eventDraft('gate.opened', {
    kind: 'stage',
    gateId,
    stageId,
    templateGateId: gateId,
    stageKind,
    optional: true,
    title: gateId,
    options: [],
    content: { type: 'work-items', artifactId: 'art-x' },
    version: 1,
  }),
  eventDraft('gate.decided', {
    gateId,
    decision: 'approve',
    by: 'user',
    version: 1,
  }),
];

/** Starts the workflow and runs meeting → breakdown → implement to completion. */
export const throughStage = (
  harness: Harness,
  last: 'meeting' | 'breakdown' | 'implement' | 'integrate',
): Harness => {
  harness.given(startCommand());
  const steps: [string, Step[]][] = [
    ['meeting', approveGate('conclusion', 'meeting', 'meeting')],
    ['breakdown', approveGate('task-split', 'breakdown', 'planning')],
    ['implement', []],
    ['integrate', []],
  ];
  for (const [stageId, after] of steps) {
    harness.given(startStage(stageId), completeStage(stageId), ...after);
    if (stageId === last) break;
  }
  return harness;
};
