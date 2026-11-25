import type {
  DomainEvent,
  EventOfType,
  EventPayload,
  EventType,
  OndemandPurpose,
} from '@ai-office/contracts/events';
import {
  budgetAlertKey,
  canTransitionAttempt,
  GATED_STAGE_KINDS,
  initialState,
  isTimerHeld,
  stageKey,
  TIMER_PAUSE_REASON,
} from './state/index.js';
import type {
  Attempt,
  BudgetLevel,
  CommandResult,
  Gate,
  GateDecided,
  OnDemand,
  Stage,
  Usage,
  WorkflowState,
} from './state/index.js';

/**
 * `evolve` is total (§1, §4): an event it does not recognise or that does not
 * fit the current state is skipped with a warning, so old logs always replay.
 * Event-group branches below are owned per M1 plan §5.1: T9 may edit the gate /
 * submission / work-item-proposal branches, T10 the budget / question / work-item
 * / anomaly branches.
 */
export interface EvolveWarning {
  code: string;
  message: string;
  seq?: number;
  type?: string;
}

export interface EvolveResult {
  state: WorkflowState;
  warning?: EvolveWarning;
}

interface Skip {
  skip: string;
  message: string;
}
type Handler<T extends EventType> = (
  state: WorkflowState,
  event: EventOfType<T>,
) => WorkflowState | Skip;

const skip = (code: string, message: string): Skip => ({ skip: code, message });
const isSkip = (value: WorkflowState | Skip): value is Skip => 'skip' in value;

const put = <T>(
  record: Record<string, T>,
  key: string | number,
  value: T,
): Record<string, T> => ({ ...record, [key]: value });

/** The final-PR gate's revision option, as the engine's gate builder offers it. */
export const REQUEST_CHANGES_OPTION = {
  optionId: 'request-changes',
  label: 'Request changes',
} as const;

/**
 * S9: while the final PR is closed without merging, its open gate shows
 * `prClosedAt` and offers only keep-open and abort. A reopen clears the mark
 * and restores the full option set (request-changes while revisions remain).
 */
const finalPrClosure = (
  state: WorkflowState,
  pr: number,
  closedAt: string | undefined,
): WorkflowState['gates'] => {
  const config = state.workflow?.template.stages.find(
    (s) => s.kind === 'final-pr',
  );
  const integrate = Object.values(state.stages).find(
    (s) => s.kind === 'integrate',
  );
  const revisable =
    config?.kind === 'final-pr' &&
    integrate !== undefined &&
    integrate.revisions < config.maxRevisions;
  let next = state.gates;
  for (const gate of Object.values(state.gates)) {
    const content = gate.content;
    if (
      gate.status !== 'open' ||
      gate.kind !== 'stage' ||
      content.type !== 'final-pr' ||
      content.pr !== pr ||
      content.prClosedAt === closedAt
    )
      continue;
    const narrowed = gate.options.filter(
      (o) => o.optionId !== REQUEST_CHANGES_OPTION.optionId,
    );
    const reopened = { ...content };
    delete reopened.prClosedAt;
    next = put(next, gate.gateId, {
      ...gate,
      ...(closedAt === undefined
        ? {
            content: reopened,
            options: revisable
              ? [{ ...REQUEST_CHANGES_OPTION }, ...narrowed]
              : narrowed,
          }
        : { content: { ...content, prClosedAt: closedAt }, options: narrowed }),
    });
  }
  return next;
};

const putOndemand = (
  state: WorkflowState,
  stageId: string,
  purpose: OndemandPurpose,
  value: OnDemand,
): WorkflowState => ({
  ...state,
  ondemand: put(state.ondemand, stageId, {
    ...state.ondemand[stageId],
    [purpose]: value,
  }),
});

const drop = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  const next = { ...record };
  delete next[key];
  return next;
};

const omit = <T extends object, K extends keyof T>(
  value: T,
  ...keys: K[]
): Omit<T, K> => {
  const next = { ...value };
  for (const key of keys) delete next[key];
  return next;
};

const has = <T>(record: Record<string, T>, key: string | number): boolean =>
  Object.hasOwn(record, key);

const updateStage = (
  state: WorkflowState,
  stageId: string,
  update: (stage: Stage) => Stage | Skip,
): WorkflowState | Skip => {
  const stage = state.stages[stageId];
  if (stage === undefined) return skip('unknown_stage', `No stage ${stageId}`);
  const next = update(stage);
  return 'skip' in next
    ? next
    : { ...state, stages: put(state.stages, stageId, next) };
};

const updateAttempt = (
  state: WorkflowState,
  attemptId: string,
  update: (attempt: Attempt) => Attempt | Skip,
): WorkflowState | Skip => {
  const attempt = state.attempts[attemptId];
  if (attempt === undefined)
    return skip('unknown_attempt', `No attempt ${attemptId}`);
  const next = update(attempt);
  return 'skip' in next
    ? next
    : { ...state, attempts: put(state.attempts, attemptId, next) };
};

/**
 * S26: an object enters (or refreshes) the provider rate limit, keeping the
 * first `since`; `null` lifts it; `undefined` leaves it unchanged. Windows are
 * stamped with event times, the same instants engine pauses and resumes timers.
 */
const rateLimit = (
  attempt: Attempt,
  update: EventPayload<'seat.status'>['rateLimited'],
  at: string,
): Attempt => {
  if (update === undefined) return attempt;
  const windows = attempt.rateLimitWindows ?? [];
  if (update === null) {
    if (attempt.rateLimited === undefined) return attempt;
    return {
      ...omit(attempt, 'rateLimited'),
      rateLimitWindows: windows.map((w, i) =>
        i === windows.length - 1 && w.to === undefined ? { ...w, to: at } : w,
      ),
    };
  }
  return {
    ...attempt,
    rateLimited: {
      since: attempt.rateLimited?.since ?? update.since,
      evidence: update.evidence,
      ...(update.resetsAt === undefined ? {} : { resetsAt: update.resetsAt }),
      lastEvidenceAt: at,
    },
    rateLimitWindows:
      attempt.rateLimited === undefined ? [...windows, { from: at }] : windows,
  };
};

const workflowEnd = (
  state: WorkflowState,
  event: DomainEvent,
  patch: Partial<NonNullable<WorkflowState['workflow']>>,
): WorkflowState | Skip => {
  const workflow = state.workflow;
  if (workflow === null || workflow.status !== 'running')
    return skip('workflow_ended', 'Workflow is not running');
  return {
    ...state,
    workflow: { ...workflow, ...patch, endedAt: event.occurredAt },
  };
};

const addUsage = (usage: Usage | undefined, delta: Partial<Usage>): Usage => ({
  tokens: (usage?.tokens ?? 0) + (delta.tokens ?? 0),
  turns: (usage?.turns ?? 0) + (delta.turns ?? 0),
});

const recordUsage = (
  state: WorkflowState,
  attemptId: string,
  delta: Partial<Usage>,
): WorkflowState | Skip => {
  const attempt = state.attempts[attemptId];
  if (attempt === undefined)
    return skip('unknown_attempt', `No attempt ${attemptId}`);
  const key = stageKey(attempt.stageId, attempt.stageAttempt);
  return {
    ...state,
    usage: {
      workflow: addUsage(state.usage.workflow, delta),
      stages: put(
        state.usage.stages,
        key,
        addUsage(state.usage.stages[key], delta),
      ),
      attempts: put(
        state.usage.attempts,
        attemptId,
        addUsage(state.usage.attempts[attemptId], delta),
      ),
    },
  };
};

const recordBudgetAlert = (
  state: WorkflowState,
  payload: EventPayload<'budget.exceeded'>,
  level: BudgetLevel,
): WorkflowState | Skip => {
  const key = budgetAlertKey(payload, level);
  if (has(state.budgetAlerts, key))
    return skip('duplicate_budget_alert', `Budget alert ${key} already raised`);
  return {
    ...state,
    budgetAlerts: put(state.budgetAlerts, key, { ...payload, level }),
  };
};

const GATE_STATUS_BY_DECISION: Record<GateDecided['decision'], Gate['status']> =
  {
    approve: 'approved',
    revise: 'revised',
    reject: 'rejected',
    option: 'approved',
    answer: 'approved',
  };

const unchanged = (state: WorkflowState): WorkflowState => state;

const HANDLERS: { [T in EventType]: Handler<T> } = {
  // workflow (T6) -----------------------------------------------------------
  'workflow.started': (state, event) => {
    const p = event.payload;
    const stages: Record<string, Stage> = {};
    p.templateSnapshot.stages.forEach((stage, index) => {
      stages[stage.id] = {
        id: stage.id,
        kind: stage.kind,
        index,
        status: 'pending',
        attempt: 0,
        reruns: 0,
        revisions: 0,
      };
    });
    return {
      ...initialState(),
      workflowId: event.workflowId,
      lastSeq: state.lastSeq,
      workflow: {
        id: event.workflowId as string,
        shortId: p.shortId,
        template: p.templateSnapshot,
        repo: p.repo,
        requirement: p.requirement,
        integrationBranch: p.integrationBranch,
        roleOverrides: p.roleOverrides,
        gateToggles: p.gateToggles,
        budgets: p.budgets,
        limits: p.limits,
        acknowledgedUnverifiedRuntime: p.acknowledgedUnverifiedRuntime,
        startedAt: event.occurredAt,
        status: 'running',
        pausedReasons: [],
        cancelRequested: false,
      },
      stages,
      stageOrder: p.templateSnapshot.stages.map((stage) => stage.id),
    };
  },
  'workflow.paused': (state, event) => {
    const { payload } = event;
    const workflow = state.workflow;
    if (workflow === null || workflow.status !== 'running')
      return skip('workflow_ended', 'Workflow is not running');
    if (workflow.pausedReasons.includes(payload.reason))
      return skip('already_paused', `Already paused for ${payload.reason}`);
    return {
      ...state,
      workflow: {
        ...workflow,
        pausedReasons: [...workflow.pausedReasons, payload.reason],
        // FX8b: overlapping reasons share one window, opened by the first.
        ...(workflow.pausedReasons.length
          ? {}
          : {
              pauseWindows: [
                ...(workflow.pauseWindows ?? []),
                { from: event.occurredAt },
              ],
            }),
      },
    };
  },
  'workflow.resumed': (state, event) => {
    const { payload } = event;
    const workflow = state.workflow;
    if (workflow === null || !workflow.pausedReasons.includes(payload.reason))
      return skip('not_paused', `Not paused for ${payload.reason}`);
    const pausedReasons = workflow.pausedReasons.filter(
      (reason) => reason !== payload.reason,
    );
    return {
      ...state,
      workflow: {
        ...workflow,
        pausedReasons,
        // FX8b: the window closes on full unpause.
        ...(pausedReasons.length || !workflow.pauseWindows?.length
          ? {}
          : {
              pauseWindows: workflow.pauseWindows.map((window, index, all) =>
                index === all.length - 1
                  ? { ...window, to: event.occurredAt }
                  : window,
              ),
            }),
      },
    };
  },
  'workflow.completed': (state, event) =>
    workflowEnd(state, event, {
      status: 'completed',
      finalPr: event.payload.finalPr,
      ...(event.payload.mergeCommitSha === undefined
        ? {}
        : { mergeCommitSha: event.payload.mergeCommitSha }),
    }),
  'workflow.failed': (state, event) =>
    workflowEnd(state, event, { status: 'failed', failure: event.payload }),
  'workflow.cancel_requested': (state) => {
    const workflow = state.workflow;
    if (workflow === null || workflow.status !== 'running')
      return skip('workflow_ended', 'Workflow is not running');
    return { ...state, workflow: { ...workflow, cancelRequested: true } };
  },
  'workflow.cancelled': (state, event) =>
    workflowEnd(state, event, { status: 'cancelled' }),

  // stage (T6) --------------------------------------------------------------
  'stage.started': (state, event) => {
    const p = event.payload;
    const next = updateStage(state, p.stageId, (stage) => {
      if (stage.status === 'running')
        return skip('stage_running', `Stage ${stage.id} is already running`);
      if (p.attempt !== stage.attempt + 1)
        return skip(
          'attempt_out_of_order',
          `Stage ${stage.id} expected attempt ${stage.attempt + 1}`,
        );
      return {
        ...omit(
          stage,
          'pendingRerun',
          'failure',
          'endedAt',
          'feedback',
          'agentOverride',
        ),
        status: 'running',
        attempt: p.attempt,
        mode: p.mode,
        startedAt: event.occurredAt,
        reruns: stage.reruns + (p.mode === 'rerun' ? 1 : 0),
        revisions: stage.revisions + (p.mode === 'revision' ? 1 : 0),
        ...(p.feedback === undefined ? {} : { feedback: p.feedback }),
        ...(p.agentOverride === undefined
          ? {}
          : { agentOverride: p.agentOverride }),
      };
    });
    if (isSkip(next) || next.stages[p.stageId]?.kind !== 'meeting') return next;
    return {
      ...next,
      meetings: put(next.meetings, p.stageId, {
        stageId: p.stageId,
        stageAttempt: p.attempt,
        rounds: {},
      }),
    };
  },
  'stage.completed': (state, event) =>
    updateStage(state, event.payload.stageId, (stage) => {
      if (stage.status !== 'running' || stage.attempt !== event.payload.attempt)
        return skip(
          'stage_not_running',
          `Stage ${stage.id} attempt is not running`,
        );
      return {
        ...stage,
        status: GATED_STAGE_KINDS.includes(stage.kind)
          ? 'awaiting_gate'
          : 'done',
        endedAt: event.occurredAt,
      };
    }),
  'stage.failed': (state, event) =>
    updateStage(state, event.payload.stageId, (stage) => {
      const p = event.payload;
      if (stage.status !== 'running' || stage.attempt !== p.attempt)
        return skip(
          'stage_not_running',
          `Stage ${stage.id} attempt is not running`,
        );
      return {
        ...stage,
        status: 'failed',
        endedAt: event.occurredAt,
        failure:
          p.detail === undefined
            ? { reason: p.reason }
            : { reason: p.reason, detail: p.detail },
      };
    }),
  'stage.rerun_requested': (state, { payload: p }) =>
    updateStage(state, p.stageId, (stage) => {
      if (
        stage.status === 'running' ||
        stage.attempt === 0 ||
        stage.attempt !== p.fromAttempt
      )
        return skip(
          'rerun_not_applicable',
          `Stage ${stage.id} cannot rerun now`,
        );
      return {
        ...stage,
        pendingRerun: {
          mode: p.mode,
          by: p.by,
          fromAttempt: p.fromAttempt,
          ...(p.gateId === undefined ? {} : { gateId: p.gateId }),
          ...(p.feedback === undefined ? {} : { feedback: p.feedback }),
          ...(p.agentOverride === undefined
            ? {}
            : { agentOverride: p.agentOverride }),
        },
      };
    }),

  // gate (T6 baseline; T9 refines) -------------------------------------------
  'gate.opened': (state, event) => {
    const p = event.payload;
    if (has(state.gates, p.gateId))
      return skip('duplicate_gate', `Gate ${p.gateId} already opened`);
    if (!has(state.stages, p.stageId))
      return skip('unknown_stage', `No stage ${p.stageId}`);
    return {
      ...state,
      gates: put(state.gates, p.gateId, {
        ...p,
        status: 'open',
        openedAt: event.occurredAt,
      }),
    };
  },
  'gate.content_updated': (state, { payload: p }) => {
    const gate = state.gates[p.gateId];
    if (gate?.status !== 'open')
      return skip('gate_not_open', `Gate ${p.gateId} is not open`);
    if (p.version <= gate.version)
      return skip(
        'stale_gate_version',
        `Gate ${p.gateId} is at ${gate.version}`,
      );
    return {
      ...state,
      gates: put(state.gates, p.gateId, {
        ...gate,
        version: p.version,
        ...(p.source === 'github'
          ? {
              github: {
                bodyHash: p.bodyHash,
                githubUpdatedAt: p.githubUpdatedAt,
              },
            }
          : p.artifactId === undefined
            ? {}
            : { contentArtifactId: p.artifactId }),
      }),
    };
  },
  'gate.decided': (state, event) => {
    const p = event.payload;
    const gate = state.gates[p.gateId];
    if (gate?.status !== 'open')
      return skip('gate_not_open', `Gate ${p.gateId} is not open`);
    const next: WorkflowState = {
      ...state,
      gates: put(state.gates, p.gateId, {
        ...gate,
        status: GATE_STATUS_BY_DECISION[p.decision],
        decision: { ...p, decidedAt: event.occurredAt },
      }),
    };
    const stage = next.stages[gate.stageId];
    if (
      gate.kind !== 'stage' ||
      stage?.status !== 'awaiting_gate' ||
      (p.decision !== 'approve' && p.decision !== 'revise')
    )
      return next;
    return {
      ...next,
      stages: put(next.stages, stage.id, { ...stage, status: 'done' }),
    };
  },
  'gate.closed': (state, { payload: p }) => {
    const gate = state.gates[p.gateId];
    if (gate === undefined || gate.status === 'closed')
      return skip('gate_not_closable', `Gate ${p.gateId} is unknown or closed`);
    const next: WorkflowState = {
      ...state,
      gates: put(state.gates, p.gateId, {
        ...gate,
        status: 'closed',
        closedReason: p.reason,
      }),
    };
    const stage = next.stages[gate.stageId];
    if (p.reason !== 'merged' || stage?.status !== 'awaiting_gate') return next;
    return {
      ...next,
      stages: put(next.stages, stage.id, { ...stage, status: 'done' }),
    };
  },

  // seat / attempt (T6) -------------------------------------------------------
  'seat.spawned': (state, event) => {
    const p = event.payload;
    if (has(state.attempts, p.attemptId))
      return skip(
        'duplicate_attempt',
        `Attempt ${p.attemptId} already spawned`,
      );
    const stage = state.stages[p.stageId];
    if (stage === undefined)
      return skip('unknown_stage', `No stage ${p.stageId}`);
    const seat = state.seats[p.seatId] ?? {
      id: p.seatId,
      role: p.role,
      ...(p.itemKey === undefined ? {} : { itemKey: p.itemKey }),
      attemptIds: [],
    };
    return {
      ...state,
      seats: put(state.seats, p.seatId, {
        ...seat,
        attemptIds: [...seat.attemptIds, p.attemptId],
      }),
      attempts: put(state.attempts, p.attemptId, {
        ...p,
        stageAttempt: stage.attempt,
        spawnedAt: event.occurredAt,
        state: 'starting',
        degraded: false,
        released: false,
        policyHits: [],
        nudges: [],
        submissions: {},
      }),
    };
  },
  'seat.status': (state, event) =>
    updateAttempt(state, event.payload.attemptId, (attempt) => {
      const p = event.payload;
      if (attempt.released)
        return skip(
          'attempt_released',
          `Attempt ${attempt.attemptId} is released`,
        );
      if (
        p.state !== attempt.state &&
        !canTransitionAttempt(attempt.state, p.state)
      )
        return skip(
          'invalid_attempt_transition',
          `Attempt ${attempt.attemptId}: ${attempt.state} → ${p.state}`,
        );
      return rateLimit(
        {
          ...omit(attempt, 'waitingSince'),
          state: p.state,
          ...(p.state === 'done' ? { doneTurn: attempt.turns ?? 0 } : {}),
          ...(p.state === 'waiting_input'
            ? {
                waitingSince:
                  p.waitingSince ?? attempt.waitingSince ?? event.occurredAt,
              }
            : {}),
        },
        p.rateLimited,
        event.occurredAt,
      );
    }),
  'seat.activity': (state, event) =>
    updateAttempt(state, event.payload.attemptId, (attempt) => ({
      ...attempt,
      lastActivityAt: event.occurredAt,
    })),
  'seat.degraded': (state, { payload: p }) =>
    updateAttempt(state, p.attemptId, (attempt) => ({
      ...attempt,
      degraded: true,
    })),
  'seat.policy_violation': (state, { payload: p }) =>
    updateAttempt(state, p.attemptId, (attempt) => ({
      ...attempt,
      policyHits: [...attempt.policyHits, ...p.hits],
    })),
  'seat.exited': (state, { payload: p, occurredAt }) =>
    updateAttempt(state, p.attemptId, (attempt) => {
      if (attempt.state === 'exited')
        return skip('already_exited', `Attempt ${p.attemptId} already exited`);
      // An exited attempt no longer waits for quota (S26).
      return rateLimit(
        {
          ...omit(attempt, 'waitingSince'),
          state: 'exited',
          exit: { reason: p.reason, expected: p.expected },
        },
        null,
        occurredAt,
      );
    }),
  'seat.released': (state, { payload: p }) =>
    updateAttempt(state, p.attemptId, (attempt) => {
      if (attempt.released)
        return skip(
          'already_released',
          `Attempt ${p.attemptId} already released`,
        );
      return { ...attempt, released: true, removeWorkspace: p.removeWorkspace };
    }),
  'agent.unmanaged': (state, { payload }) => ({
    ...state,
    unmanagedAgents: [...state.unmanagedAgents, payload],
  }),

  // meeting (T6 baseline; engine T13 relies on it) ---------------------------
  'meeting.round_started': (state, { payload: p }) => {
    const meeting = state.meetings[p.stageId];
    if (meeting === undefined)
      return skip('unknown_meeting', `Stage ${p.stageId} has no meeting`);
    if (has(meeting.rounds, p.round))
      return skip('duplicate_round', `Round ${p.round} already started`);
    return {
      ...state,
      meetings: put(state.meetings, p.stageId, {
        ...meeting,
        rounds: put(meeting.rounds, p.round, {
          round: p.round,
          attemptIds: p.attemptIds,
          statements: {},
        }),
      }),
    };
  },
  'meeting.statement': (state, { payload: p }) => {
    const meeting = state.meetings[p.stageId];
    const round = meeting?.rounds[p.statement.round];
    if (meeting === undefined || round === undefined)
      return skip(
        'unknown_round',
        `No round ${p.statement.round} in ${p.stageId}`,
      );
    return {
      ...state,
      meetings: put(state.meetings, p.stageId, {
        ...meeting,
        rounds: put(meeting.rounds, round.round, {
          ...round,
          statements: put(round.statements, p.attemptId, {
            artifactId: p.artifactId,
            readyToConclude: p.statement.readyToConclude,
          }),
        }),
      }),
    };
  },
  'meeting.round_completed': (state, { payload: p }) => {
    const meeting = state.meetings[p.stageId];
    const round = meeting?.rounds[p.round];
    if (meeting === undefined || round === undefined || round.completed)
      return skip(
        'round_not_open',
        `Round ${p.round} in ${p.stageId} is not open`,
      );
    return {
      ...state,
      meetings: put(state.meetings, p.stageId, {
        ...meeting,
        rounds: put(meeting.rounds, p.round, {
          ...round,
          completed: omit(p, 'stageId', 'round'),
        }),
      }),
    };
  },
  'meeting.concluded': (state, { payload: p }) => {
    const meeting = state.meetings[p.stageId];
    if (meeting === undefined || meeting.concluded)
      return skip('meeting_not_open', `Meeting ${p.stageId} is not open`);
    return {
      ...state,
      meetings: put(state.meetings, p.stageId, {
        ...meeting,
        concluded: omit(p, 'stageId'),
      }),
    };
  },

  // submission (T6 baseline; T9 refines) -------------------------------------
  'submission.accepted': (state, event) => {
    const p = event.payload;
    if (has(state.submissions, p.submissionId))
      return skip(
        'duplicate_submission',
        `Submission ${p.submissionId} exists`,
      );
    const next = updateAttempt(state, p.attemptId, (attempt) => ({
      ...attempt,
      submissions: { ...attempt.submissions, [p.kind]: p.submissionId },
      ...(p.agentSession === undefined ? {} : { agentSession: p.agentSession }),
    }));
    if (isSkip(next)) return next;
    return {
      ...next,
      submissions: put(next.submissions, p.submissionId, {
        id: p.submissionId,
        attemptId: p.attemptId,
        kind: p.kind,
        submission: p.submission,
        ...(p.artifactId === undefined ? {} : { artifactId: p.artifactId }),
        acceptedAt: event.occurredAt,
      }),
    };
  },
  'submission.rejected': (state) => ({
    ...state,
    rejectedSubmissions: state.rejectedSubmissions + 1,
  }),

  // message / question (T6 baseline; T10 refines) ---------------------------
  'message.question': (state, event) => {
    const p = event.payload;
    if (has(state.questions, p.questionId))
      return skip('duplicate_question', `Question ${p.questionId} exists`);
    return {
      ...state,
      questions: put(state.questions, p.questionId, {
        id: p.questionId,
        attemptId: p.attemptId,
        ...(p.itemKey === undefined ? {} : { itemKey: p.itemKey }),
        body: p.body,
        askedAt: event.occurredAt,
        status: 'open',
      }),
    };
  },
  'message.forwarded': (state, { payload: p }) => {
    const question = state.questions[p.questionId];
    if (
      question === undefined ||
      (question.status !== 'open' && question.status !== 'forwarded')
    )
      return skip(
        'question_not_forwardable',
        `Question ${p.questionId} cannot be forwarded`,
      );
    return {
      ...state,
      questions: put(state.questions, p.questionId, {
        ...question,
        status: 'forwarded',
        forwarded: omit(p, 'questionId'),
      }),
    };
  },
  'message.answered': (state, event) => {
    const p = event.payload;
    const question = state.questions[p.questionId];
    if (question === undefined || question.status === 'answered')
      return skip('question_not_open', `Question ${p.questionId} is not open`);
    return {
      ...state,
      questions: put(state.questions, p.questionId, {
        ...question,
        status: 'answered',
        answeredAt: event.occurredAt,
        answer: omit(p, 'questionId'),
      }),
    };
  },
  'message.escalated': (state, { payload: p }) => {
    const question = state.questions[p.questionId];
    if (
      question === undefined ||
      question.status === 'answered' ||
      question.status === 'escalated'
    )
      return skip(
        'question_not_escalatable',
        `Question ${p.questionId} cannot escalate`,
      );
    return {
      ...state,
      questions: put(state.questions, p.questionId, {
        ...question,
        status: 'escalated',
        escalation: omit(p, 'questionId'),
      }),
    };
  },
  'message.nudge': (state, { payload: p }) =>
    updateAttempt(state, p.attemptId, (attempt) => ({
      ...attempt,
      nudges: [...attempt.nudges, { reason: p.reason, subject: p.subject }],
    })),
  'message.instruction': unchanged,

  // on-demand instances (T6 baseline as on-call; rev2.10 adds `purpose`) ----
  'ondemand.started': (state, { payload: p }) =>
    putOndemand(state, p.stageId, p.purpose, {
      ...omit<OnDemand, 'stopped'>(
        state.ondemand[p.stageId]?.[p.purpose] ?? {
          stageId: p.stageId,
          queue: [],
        },
        'stopped',
      ),
      attemptId: p.attemptId,
    }),
  'ondemand.queue_changed': (state, { payload: p }) => {
    const current = state.ondemand[p.stageId]?.[p.purpose];
    if (
      p.current !== undefined &&
      current?.attemptId !== undefined &&
      p.current !== current.current
    ) {
      const attempt = state.attempts[current.attemptId];
      if (attempt)
        state = {
          ...state,
          attempts: put(state.attempts, attempt.attemptId, {
            ...attempt,
            nudges: attempt.nudges.filter(
              (n) =>
                n.subject !== p.current ||
                n.reason !==
                  (p.purpose === 'merge'
                    ? 'review-timeout'
                    : 'question-timeout'),
            ),
          }),
        };
    }
    return putOndemand(state, p.stageId, p.purpose, {
      ...omit(current ?? { stageId: p.stageId, queue: [] }, 'current'),
      queue: p.queue,
      ...(p.current === undefined || current?.attemptId === undefined
        ? {}
        : {
            deliveries: {
              ...current.deliveries,
              [p.current]: {
                attemptId: current.attemptId,
                retries:
                  (current.deliveries?.[p.current]?.retries ?? 0) +
                  (current.deliveries?.[p.current] &&
                  current.deliveries[p.current]!.attemptId !== current.attemptId
                    ? 1
                    : 0),
              },
            },
          }),
      ...(p.current === undefined ? {} : { current: p.current }),
    });
  },
  'ondemand.stopped': (state, { payload: p }) => {
    const current = state.ondemand[p.stageId]?.[p.purpose];
    if (current === undefined || current.attemptId !== p.attemptId)
      return skip(
        'ondemand_not_running',
        `On-demand ${p.purpose} ${p.attemptId} is not running`,
      );
    return putOndemand(state, p.stageId, p.purpose, {
      ...omit(current, 'current'),
      stopped: p.reason,
    });
  },

  // work items (T6 baseline; T9 proposals/approval, T10 dispatch/status) -----
  'workitem.proposed': (state, { payload: p }) => ({
    ...state,
    proposals: put(state.proposals, p.stageId, {
      stageId: p.stageId,
      submissionId: p.submissionId,
      items: p.items,
    }),
  }),
  'workitem.approved': (state, { payload: p }) => {
    if (state.workItemOrder.length > 0)
      return skip('already_approved', 'Work items were already approved');
    const workItems: WorkflowState['workItems'] = {};
    for (const item of p.items)
      workItems[item.key] = {
        ...item,
        status: 'approved',
        approvedGateId: p.gateId,
        attemptIds: [],
        attempt: 0,
      };
    return {
      ...state,
      workItems,
      workItemOrder: p.items.map((item) => item.key),
    };
  },
  'workitem.dispatched': (state, { payload: p }) => {
    const item = state.workItems[p.itemKey];
    if (item === undefined)
      return skip('unknown_item', `No work item ${p.itemKey}`);
    if (p.attempt !== item.attempt + 1)
      return skip(
        'attempt_out_of_order',
        `Item ${p.itemKey} expected ${item.attempt + 1}`,
      );
    return {
      ...state,
      workItems: put(state.workItems, p.itemKey, {
        ...omit(
          item,
          'headSha',
          'baseSha',
          'reworkOf',
          'statusReason',
          ...(p.reworkOf === undefined ? ['pr' as const] : []),
        ),
        status: 'dispatched',
        ...(p.baseSha === undefined ? {} : { baseSha: p.baseSha }),
        ...(p.reworkOf === undefined ? {} : { reworkOf: p.reworkOf }),
        agent: p.agent,
        attempt: p.attempt,
        attemptIds: [...item.attemptIds, p.attemptId],
        currentAttemptId: p.attemptId,
        branch: p.branch,
        workspaceName: p.workspaceName,
      }),
    };
  },
  'workitem.status': (state, { payload: p }) => {
    const item = state.workItems[p.itemKey];
    if (item === undefined)
      return skip('unknown_item', `No work item ${p.itemKey}`);
    // A human-authorized requeue starts a fresh review retry allowance.
    if (p.status === 'merge_queued' && p.reason !== undefined) {
      const gate = state.gates[p.reason];
      const instance =
        gate === undefined ? undefined : state.ondemand[gate.stageId]?.merge;
      if (gate?.decision?.optionId === 'requeue' && instance?.deliveries)
        state = putOndemand(state, gate.stageId, 'merge', {
          ...instance,
          deliveries: drop(instance.deliveries, p.itemKey),
        });
    }
    return {
      ...state,
      workItems: put(state.workItems, p.itemKey, {
        ...item,
        status: p.status,
        ...(p.issue === undefined ? {} : { issue: p.issue }),
        ...(p.pr === undefined ? {} : { pr: p.pr }),
        ...(p.headSha === undefined ? {} : { headSha: p.headSha }),
        ...(p.reason === undefined ? {} : { statusReason: p.reason }),
      }),
    };
  },
  'workitem.merge_queued': (state, { payload: p }) => {
    const item = state.workItems[p.itemKey];
    if (!item) return skip('unknown_item', 'Queue references an unknown item');
    if (item.currentAttemptId !== p.attemptId)
      return skip('stale_attempt', 'Queue references an old attempt');
    const stage = state.stageOrder.find(
      (id) => state.stages[id]?.kind === 'implement',
    );
    const instance =
      stage === undefined ? undefined : state.ondemand[stage]?.merge;
    if (stage !== undefined && instance?.deliveries?.[p.itemKey])
      state = putOndemand(state, stage, 'merge', {
        ...instance,
        deliveries: drop(instance.deliveries, p.itemKey),
      });
    return {
      ...state,
      workItems: put(state.workItems, p.itemKey, {
        ...item,
        status: 'merge_queued',
        pr: p.pr,
        headSha: p.headSha,
      }),
    };
  },
  'workitem.rework_requested': (state, { payload: p }) => {
    const item = state.workItems[p.itemKey];
    if (!item) return skip('unknown_item', 'Rework references an unknown item');
    if (item.pr !== p.pr || p.rework !== (item.rework ?? 0) + 1)
      return skip('stale_rework', 'Rework is out of order');
    return {
      ...state,
      workItems: put(state.workItems, p.itemKey, {
        ...item,
        status: 'rework',
        rework: p.rework,
        reworkRequest: p,
        reworkSubmissionIds: [
          ...(item.reworkSubmissionIds ?? []),
          p.submissionId,
        ],
      }),
    };
  },
  'workitem.merged': (state, { payload: p }) => {
    const item = state.workItems[p.itemKey];
    if (!item) return skip('unknown_item', 'Merge references an unknown item');
    if (item.pr !== p.pr)
      return skip('stale_pr', 'Merge references a different PR');
    return {
      ...state,
      workItems: put(state.workItems, p.itemKey, {
        ...item,
        status: 'merged',
        mergeCommitSha: p.mergeCommitSha,
      }),
    };
  },

  // artifacts and SCM --------------------------------------------------------
  'artifact.created': (state, event) => {
    const p = event.payload;
    if (has(state.artifacts, p.artifactId))
      return skip('duplicate_artifact', `Artifact ${p.artifactId} exists`);
    const next: WorkflowState = {
      ...state,
      artifacts: put(state.artifacts, p.artifactId, {
        ...p,
        createdAt: event.occurredAt,
      }),
    };
    if (p.kind === 'pr' && p.purpose === 'final' && next.workflow !== null)
      return { ...next, workflow: { ...next.workflow, finalPr: p.number } };
    const item =
      (p.kind === 'issue' || p.kind === 'pr') && p.itemKey !== undefined
        ? next.workItems[p.itemKey]
        : undefined;
    if (item === undefined || (p.kind !== 'issue' && p.kind !== 'pr'))
      return next;
    return {
      ...next,
      workItems: put(next.workItems, item.key, {
        ...item,
        ...(p.kind === 'issue' ? { issue: p.number } : { pr: p.number }),
      }),
    };
  },
  'pr.status': (state, { payload, occurredAt }) => {
    const key = String(payload.pr);
    const { [key]: since, ...others } = state.prsClosedAt ?? {};
    const closedAt =
      payload.state === 'closed' ? (since ?? occurredAt) : undefined;
    const prsClosedAt =
      closedAt === undefined ? others : { ...others, [key]: closedAt };
    return {
      ...state,
      prs: put(state.prs, payload.pr, payload),
      ...(state.prsClosedAt || closedAt ? { prsClosedAt } : {}),
      gates: finalPrClosure(state, payload.pr, closedAt),
    };
  },
  'scm.issue_drift': (state, { payload }) => ({
    ...state,
    issueDrift: put(state.issueDrift, payload.issue, payload),
  }),
  'anomaly.detected': (state, event) => ({
    ...state,
    anomalies: [
      ...state.anomalies,
      { ...event.payload, detectedAt: event.occurredAt },
    ],
  }),

  // usage / budget (T6 baseline; T10 refines) --------------------------------
  'usage.tokens': (state, { payload: p }) =>
    recordUsage(state, p.attemptId, { tokens: p.budgetTokens }),
  'usage.turns': (state, { payload: p }) =>
    recordUsage(state, p.attemptId, { turns: p.turns }),
  'budget.exceeded': (state, { payload }) =>
    recordBudgetAlert(state, payload, 'exceeded'),
  'budget.hard_limit': (state, { payload }) =>
    recordBudgetAlert(state, payload, 'hard_limit'),

  // command ledger (outbox, §11.5) --------------------------------------------
  'command.issued': (state, event) => {
    const p = event.payload;
    if (has(state.commands, p.commandId))
      return skip('duplicate_command', `Command ${p.commandId} exists`);
    // A send or answer is a new turn for its attempt (T12 `isTurnDone`); an
    // answer names its question, whose attempt asked it.
    const turnedId =
      p.kind === 'runtime.send'
        ? event.attemptId
        : p.kind === 'runtime.answer'
          ? (event.attemptId ?? state.questions[p.args.question]?.attemptId)
          : undefined;
    const turned =
      turnedId === undefined ? undefined : state.attempts[turnedId];
    return {
      ...state,
      ...(turned
        ? {
            attempts: put(state.attempts, turned.attemptId, {
              ...turned,
              turns: (turned.turns ?? 0) + 1,
            }),
          }
        : {}),
      commands: put(state.commands, p.commandId, {
        id: p.commandId,
        issued: p,
        ...(event.attemptId === undefined
          ? {}
          : { attemptId: event.attemptId }),
        issuedAt: event.occurredAt,
        status: 'issued',
      }),
    };
  },
  'command.succeeded': (state, { payload: p }) => {
    const command = state.commands[p.commandId];
    if (command === undefined || command.issued.kind !== p.kind)
      return skip('unknown_command', `No ${p.kind} command ${p.commandId}`);
    const result = omit(p, 'commandId') as CommandResult;
    let next: WorkflowState = {
      ...state,
      commands: put(state.commands, p.commandId, {
        ...omit(command, 'error'),
        status: 'succeeded',
        result,
      }),
    };
    if (p.kind === 'runtime.spawnAgent') {
      const attempt = Object.values(next.attempts).find(
        (candidate) => candidate.spawnCommandId === p.commandId,
      );
      if (attempt !== undefined)
        next = {
          ...next,
          attempts: put(next.attempts, attempt.attemptId, {
            ...attempt,
            agentRef: p.result.agent,
          }),
        };
    }
    return next;
  },
  'command.failed': (state, { payload: p }) => {
    const command = state.commands[p.commandId];
    if (command === undefined)
      return skip('unknown_command', `No command ${p.commandId}`);
    return {
      ...state,
      commands: put(state.commands, p.commandId, {
        ...command,
        status: 'failed',
        error: p.error,
        failedAttempts: p.attempts,
      }),
    };
  },
  'command.reconciled': (state, { payload: p }) => {
    const command = state.commands[p.commandId];
    if (command === undefined)
      return skip('unknown_command', `No command ${p.commandId}`);
    return {
      ...state,
      commands: put(state.commands, p.commandId, {
        ...command,
        reconciled: p.outcome,
      }),
    };
  },

  // timers ------------------------------------------------------------------
  'timer.scheduled': (state, event) => {
    const p = event.payload;
    const timer = state.timers[p.timerId];
    // Rescheduling resumes a rate-limit-paused timer (S26) or shifts one a past
    // workflow pause held (FX8b); otherwise ids are unique.
    if (
      has(state.timers, p.timerId) &&
      timer !== undefined &&
      !timer.pausedAt &&
      (state.workflow?.pausedReasons.length || !isTimerHeld(state, timer))
    )
      return skip('duplicate_timer', `Timer ${p.timerId} is already scheduled`);
    return {
      ...state,
      timers: put(state.timers, p.timerId, {
        id: p.timerId,
        fireAt: p.fireAt,
        payload: p.payload,
        scheduledAt: event.occurredAt,
      }),
    };
  },
  'timer.fired': (state, { payload: p }) =>
    !has(state.timers, p.timerId)
      ? skip('unknown_timer', `Timer ${p.timerId} is not pending`)
      : state.timers[p.timerId]!.pausedAt
        ? skip('timer_paused', `Timer ${p.timerId} is paused`)
        : { ...state, timers: drop(state.timers, p.timerId) },
  'timer.cancelled': (state, event) => {
    const p = event.payload;
    const timer = state.timers[p.timerId];
    if (!has(state.timers, p.timerId) || timer === undefined)
      return skip('unknown_timer', `Timer ${p.timerId} is not pending`);
    if (p.reason !== TIMER_PAUSE_REASON)
      return { ...state, timers: drop(state.timers, p.timerId) };
    if (timer.pausedAt)
      return skip('timer_paused', `Timer ${p.timerId} is already paused`);
    return {
      ...state,
      timers: put(state.timers, p.timerId, {
        ...timer,
        pausedAt: event.occurredAt,
      }),
    };
  },

  // system: no per-workflow state ---------------------------------------------
  'repo.registered': unchanged,
  'repo.updated': unchanged,
  'health.changed': unchanged,
  'runtime.identity_restored': unchanged,
  'runtime.identity_hijacked': unchanged,
  'error.recorded': unchanged,
};

/** Event types that may carry `workflowId: null` (§14 "system"). */
const SYSTEM_EVENT_TYPES: ReadonlySet<string> = new Set<EventType>([
  'repo.registered',
  'repo.updated',
  'health.changed',
  'runtime.identity_restored',
  'runtime.identity_hijacked',
  'error.recorded',
  'agent.unmanaged',
  'anomaly.detected',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Applies one stored event, reporting why it was skipped if it was. Never throws. */
export const evolveWithWarning = (
  state: WorkflowState,
  event: DomainEvent,
): EvolveResult => {
  const raw: unknown = event;
  const warn = (
    code: string,
    message: string,
    consumed: boolean,
  ): EvolveResult => {
    const seq =
      isRecord(raw) && typeof raw.seq === 'number' ? raw.seq : undefined;
    const type =
      isRecord(raw) && typeof raw.type === 'string' ? raw.type : undefined;
    return {
      state: consumed && seq !== undefined ? { ...state, lastSeq: seq } : state,
      warning: {
        code,
        message,
        ...(seq === undefined ? {} : { seq }),
        ...(type === undefined ? {} : { type }),
      },
    };
  };
  if (
    !isRecord(raw) ||
    typeof raw.type !== 'string' ||
    typeof raw.seq !== 'number' ||
    !Number.isFinite(raw.seq) ||
    !isRecord(raw.payload) ||
    (raw.workflowId !== null && typeof raw.workflowId !== 'string')
  )
    return warn('malformed_event', 'Event envelope is malformed', false);
  if (raw.seq <= state.lastSeq)
    return warn('stale_seq', `Event seq ${raw.seq} ≤ ${state.lastSeq}`, false);
  if (!Object.hasOwn(HANDLERS, raw.type))
    return warn('unknown_type', `Unknown event type ${raw.type}`, true);
  if (event.workflowId === null) {
    if (SYSTEM_EVENT_TYPES.has(event.type))
      return { state: { ...state, lastSeq: event.seq } };
    return warn('missing_workflow', `${event.type} needs a workflowId`, true);
  }
  if (event.type === 'workflow.started') {
    if (state.workflowId !== null)
      return warn('duplicate_start', 'Workflow already started', true);
  } else if (state.workflowId === null) {
    return warn('workflow_not_started', 'Workflow has not started', true);
  } else if (event.workflowId !== state.workflowId) {
    return warn(
      'foreign_workflow',
      `Event belongs to ${event.workflowId}`,
      true,
    );
  }
  try {
    const handler = HANDLERS[event.type] as Handler<EventType>;
    const next = handler(state, event);
    if (isSkip(next)) return warn(next.skip, next.message, true);
    return { state: { ...next, lastSeq: event.seq } };
  } catch (error) {
    return warn(
      'handler_error',
      error instanceof Error ? error.message : String(error),
      true,
    );
  }
};

export const evolve = (
  state: WorkflowState,
  event: DomainEvent,
): WorkflowState => evolveWithWarning(state, event).state;

/** Folds a stored event log into state, collecting skip warnings. */
export const replay = (
  events: Iterable<DomainEvent>,
  from: WorkflowState = initialState(),
): { state: WorkflowState; warnings: EvolveWarning[] } => {
  let state = from;
  const warnings: EvolveWarning[] = [];
  for (const event of events) {
    const result = evolveWithWarning(state, event);
    state = result.state;
    if (result.warning !== undefined) warnings.push(result.warning);
  }
  return { state, warnings };
};

/** Every event type evolve understands; equals contracts' EVENT_TYPES (tested). */
export const HANDLED_EVENT_TYPES = Object.keys(HANDLERS) as EventType[];
