import type {
  DomainEventDraft,
  EventPayload,
} from '@ai-office/contracts/events';
import type { BudgetCommand } from '../commands.js';
import { accept, reject } from '../errors.js';
import type { DecideResult } from '../errors.js';
import { budgetAlertKey, stageKey } from '../state/index.js';
import type { WorkflowState } from '../state/index.js';
import { questionWaitMilliseconds } from './question.js';
import { draft } from './support.js';

type Alert = EventPayload<'budget.exceeded'>;

/** Gate ids are stable across retries; engine uses the id carried by the alert. */
const alerts = (
  state: WorkflowState,
  command: BudgetCommand,
  candidate: Alert,
): DomainEventDraft[] => {
  const workflow = state.workflow!;
  // Top-ups belong to the exact scope/attempt that raised the gate, never its siblings.
  const extra = Object.values(state.budgetAlerts).reduce((sum, alert) => {
    if (
      budgetAlertKey(alert, 'exceeded') !==
        budgetAlertKey(candidate, 'exceeded') ||
      alert.gateId === undefined
    )
      return sum;
    const gate = state.gates[alert.gateId];
    return (
      sum +
      (gate?.status === 'approved' ? (gate.decision?.additionalTokens ?? 0) : 0)
    );
  }, 0);
  const budget = candidate.budget + (candidate.metric === 'tokens' ? extra : 0);
  return (['exceeded', 'hard_limit'] as const).flatMap((level) => {
    const key = budgetAlertKey(candidate, level);
    const threshold = Math.ceil(
      budget *
        (level === 'hard_limit' ? workflow.budgets.hardLimitMultiplier : 1),
    );
    if (state.budgetAlerts[key] !== undefined || candidate.used < threshold)
      return [];
    return [
      draft(
        command.meta,
        {
          workflowId: workflow.id,
          ...('stageId' in candidate ? { stageId: candidate.stageId } : {}),
        },
        `budget.${level}`,
        {
          ...candidate,
          budget,
          threshold,
          gateId: `budget-${workflow.id}-${key}`,
        },
      ),
    ];
  });
};

export const decideBudget = (
  state: WorkflowState,
  command: BudgetCommand,
): DecideResult => {
  const workflow = state.workflow;
  if (workflow === null)
    return reject(
      'conflict',
      'workflow_not_started',
      'Workflow has not started',
    );
  if (command.type === 'RecordWallclockLimit') {
    if (!Number.isFinite(command.usedMinutes) || command.usedMinutes < 0)
      return reject(
        'validation',
        'invalid_usage',
        'Elapsed minutes must be nonnegative',
      );
    const stage = state.stages[command.stageId];
    const config = workflow.template.stages.find(
      (s) => s.id === command.stageId,
    );
    if (stage === undefined || stage.attempt === 0 || config === undefined)
      return reject('validation', 'unknown_stage', 'No started stage');
    if (config.kind === 'final-pr') return accept();
    let candidate: Alert;
    if (config.kind === 'implement') {
      const attempt =
        command.attemptId === undefined
          ? undefined
          : state.attempts[command.attemptId];
      if (
        attempt === undefined ||
        attempt.stageId !== stage.id ||
        attempt.itemKey === undefined ||
        attempt.itemKey !== command.itemKey
      )
        return reject(
          'validation',
          'invalid_item_attempt',
          'Item timeout requires its worker attempt',
        );
      candidate = {
        scope: 'item',
        stageId: stage.id,
        itemKey: attempt.itemKey,
        attemptId: attempt.attemptId,
        metric: 'wallclock',
        used: Math.max(
          0,
          Math.floor(
            command.usedMinutes -
              questionWaitMilliseconds(
                state,
                attempt.attemptId,
                command.meta.occurredAt,
              ) /
                60_000,
          ),
        ),
        budget: config.timeouts.itemMin,
        threshold: config.timeouts.itemMin,
      };
    } else {
      if (command.itemKey !== undefined || command.attemptId !== undefined)
        return reject(
          'validation',
          'invalid_timeout_scope',
          'Stage timeout cannot target an item',
        );
      candidate = {
        scope: 'stage',
        stageId: stage.id,
        stageAttempt: stage.attempt,
        metric: 'wallclock',
        used: Math.floor(command.usedMinutes),
        budget: config.timeouts.stageMin,
        threshold: config.timeouts.stageMin,
      };
    }
    return accept(...alerts(state, command, candidate));
  }
  const attempt = state.attempts[command.usage.attemptId];
  if (attempt === undefined)
    return reject('validation', 'unknown_attempt', 'No usage attempt');
  const metric = command.type === 'RecordUsageTokens' ? 'tokens' : 'turns';
  const delta =
    command.type === 'RecordUsageTokens'
      ? command.usage.budgetTokens
      : command.usage.turns;
  if (
    Object.values(command.usage).some(
      (v) => typeof v === 'number' && (!Number.isSafeInteger(v) || v < 0),
    ) ||
    (metric === 'turns' && delta === 0)
  )
    return reject(
      'validation',
      'invalid_usage',
      'Usage must contain nonnegative integer deltas (positive turns)',
    );
  const events = [
    command.type === 'RecordUsageTokens'
      ? draft(
          command.meta,
          {
            workflowId: workflow.id,
            stageId: attempt.stageId,
            attemptId: attempt.attemptId,
            seatId: attempt.seatId,
          },
          'usage.tokens',
          command.usage,
        )
      : draft(
          command.meta,
          {
            workflowId: workflow.id,
            stageId: attempt.stageId,
            attemptId: attempt.attemptId,
            seatId: attempt.seatId,
          },
          'usage.turns',
          command.usage,
        ),
  ];
  const configured = workflow.budgets.stages[attempt.stageId];
  const stageBudget =
    metric === 'tokens' ? configured?.tokens : configured?.maxTurns;
  const itemBudget =
    metric === 'tokens'
      ? configured?.perItem?.tokens
      : configured?.perItem?.maxTurns;
  if (stageBudget !== undefined)
    events.push(
      ...alerts(state, command, {
        scope: 'stage',
        stageId: attempt.stageId,
        stageAttempt: attempt.stageAttempt,
        metric,
        used:
          (state.usage.stages[
            stageKey(attempt.stageId, attempt.stageAttempt)
          ]?.[metric] ?? 0) + delta,
        budget: stageBudget,
        threshold: stageBudget,
      }),
    );
  if (itemBudget !== undefined && attempt.itemKey !== undefined)
    events.push(
      ...alerts(state, command, {
        scope: 'item',
        stageId: attempt.stageId,
        itemKey: attempt.itemKey,
        attemptId: attempt.attemptId,
        metric,
        used: (state.usage.attempts[attempt.attemptId]?.[metric] ?? 0) + delta,
        budget: itemBudget,
        threshold: itemBudget,
      }),
    );
  if (metric === 'tokens' && workflow.budgets.workflow !== undefined)
    events.push(
      ...alerts(state, command, {
        scope: 'workflow',
        metric,
        used: state.usage.workflow.tokens + delta,
        budget: workflow.budgets.workflow.tokens,
        threshold: workflow.budgets.workflow.tokens,
      }),
    );
  return accept(...events);
};
