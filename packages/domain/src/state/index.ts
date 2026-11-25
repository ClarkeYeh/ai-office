import type { AttemptState, EventPayload } from '@ai-office/contracts/events';
import type {
  Attempt,
  BudgetLevel,
  Stage,
  StageKind,
  WorkflowState,
} from './types.js';

export type * from './types.js';
export { heldTimerShifts, isTimerHeld, pausedMilliseconds } from './pause.js';

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
  ondemand: {},
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

/**
 * Known to be running: not exited, lost, or released. For scheduling and
 * reachability (seat occupancy, nudges): a `lost` attempt no longer holds its
 * seat and cannot be messaged. NOT for the §8.1 "no live agent while a gate is
 * open" check; use `isAttemptPossiblyAlive` there.
 */
export const isAttemptAlive = (attempt: Attempt): boolean =>
  !attempt.released && attempt.state !== 'exited' && attempt.state !== 'lost';

/**
 * T12 latch: the attempt reported `done` for its current turn, and the backend
 * has given it no new turn since (§7.1: only a new turn returns `done` to
 * work). A later stale `working` / `idle` reading cannot undo it; exit, loss,
 * error or release do.
 */
export const isTurnDone = (attempt: Attempt): boolean =>
  attempt.state === 'done' ||
  (attempt.doneTurn !== undefined &&
    attempt.doneTurn === (attempt.turns ?? 0) &&
    !attempt.released &&
    ['working', 'waiting_input', 'idle'].includes(attempt.state));

export const liveAttempts = (state: WorkflowState): Attempt[] =>
  Object.values(state.attempts).filter(isAttemptAlive);

/**
 * Not proven stopped: neither exited nor released (§8.1 / N9). A `lost`
 * attempt counts, because it may still be running and holding its seat token;
 * pre-gate clearing stops and releases it like any live attempt.
 */
export const isAttemptPossiblyAlive = (attempt: Attempt): boolean =>
  !attempt.released && attempt.state !== 'exited';

export const possiblyLiveAttempts = (state: WorkflowState): Attempt[] =>
  Object.values(state.attempts).filter(isAttemptPossiblyAlive);

/** `timer.cancelled` reason that pauses a timer instead of dropping it (S26). */
export const TIMER_PAUSE_REASON = 'rate_limited';

/** A live attempt the provider currently rate-limits; its engine timers are paused (S26). */
export const isRateLimited = (attempt: Attempt): boolean =>
  attempt.rateLimited !== undefined && isAttemptAlive(attempt);

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
