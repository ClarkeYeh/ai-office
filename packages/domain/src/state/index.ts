import type { AttemptState, EventPayload } from '@ai-office/contracts/events';
import type {
  Attempt,
  BudgetLevel,
  Stage,
  StageKind,
  WorkflowState,
} from './types.js';

export type * from './types.js';

export const initialState = (): WorkflowState => ({
  workflowId: null,
  lastSeq: 0,
  workflow: null,
  stages: {},
  stageOrder: [],
  gates: {},
  seats: {},
  attempts: {},
  meetings: {},
  submissions: {},
  rejectedSubmissions: 0,
  questions: {},
  oncall: {},
  proposals: {},
  workItems: {},
  workItemOrder: [],
  artifacts: {},
  prs: {},
  issueDrift: {},
  anomalies: [],
  unmanagedAgents: [],
  usage: { workflow: { tokens: 0, turns: 0 }, stages: {}, attempts: {} },
  budgetAlerts: {},
  commands: {},
  timers: {},
});

/**
 * §4's eight attempt states. `exited` is final; `lost` (vanished from the
 * runtime's list) may still be confirmed as `exited` later. `done` returns to
 * work when a keep-open agent receives its next round (§7.1).
 */
export const ATTEMPT_TRANSITIONS: Record<
  AttemptState,
  readonly AttemptState[]
> = {
  starting: [
    'working',
    'waiting_input',
    'idle',
    'done',
    'error',
    'exited',
    'lost',
  ],
  working: ['waiting_input', 'idle', 'done', 'error', 'exited', 'lost'],
  waiting_input: ['working', 'idle', 'done', 'error', 'exited', 'lost'],
  idle: ['working', 'waiting_input', 'done', 'error', 'exited', 'lost'],
  done: ['working', 'waiting_input', 'idle', 'error', 'exited', 'lost'],
  error: ['exited', 'lost'],
  exited: [],
  lost: ['exited'],
};

export const canTransitionAttempt = (
  from: AttemptState,
  to: AttemptState,
): boolean => ATTEMPT_TRANSITIONS[from].includes(to);

/** §8.1: an attempt counts as alive until it is exited, lost, or released. */
export const isAttemptAlive = (attempt: Attempt): boolean =>
  !attempt.released && attempt.state !== 'exited' && attempt.state !== 'lost';

export const liveAttempts = (state: WorkflowState): Attempt[] =>
  Object.values(state.attempts).filter(isAttemptAlive);

export const latestAttempt = (
  state: WorkflowState,
  seatId: string,
): Attempt | undefined => {
  const id = state.seats[seatId]?.attemptIds.at(-1);
  return id === undefined ? undefined : state.attempts[id];
};

/** A seat's state is its latest attempt's (§4); `undefined` for an empty seat. */
export const seatState = (
  state: WorkflowState,
  seatId: string,
): AttemptState | undefined => latestAttempt(state, seatId)?.state;

export const GATED_STAGE_KINDS: readonly StageKind[] = [
  'meeting',
  'planning',
  'final-pr',
];

export const stageKey = (stageId: string, stageAttempt: number): string =>
  `${stageId}#${stageAttempt}`;

export const stageByKind = (
  state: WorkflowState,
  kind: StageKind,
): Stage | undefined =>
  state.stageOrder
    .map((id) => state.stages[id])
    .find((stage): stage is Stage => stage?.kind === kind);

/** §10.1 dedupe: one gate per level per stage attempt / item attempt / workflow. */
export const budgetAlertKey = (
  alert: EventPayload<'budget.exceeded'>,
  level: BudgetLevel,
): string => {
  switch (alert.scope) {
    case 'workflow':
      return `workflow|${level}`;
    case 'stage':
      return `stage|${stageKey(alert.stageId, alert.stageAttempt)}|${level}`;
    case 'item':
      return `item|${alert.attemptId}|${level}`;
  }
};
