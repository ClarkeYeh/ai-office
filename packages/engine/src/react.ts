import type { DomainEvent } from '@ai-office/contracts/events';
import { evolveWithWarning } from '@ai-office/domain';
import type { WorkflowState } from '@ai-office/domain';
import type { ReactContext } from './context.js';
import type { Effect } from './effects.js';
import { reactLifecycle } from './lifecycle.js';
import { budgetPolicy, filterPolicyEffects } from './policies/budget.js';
import { cancelPolicy } from './policies/cancel.js';
import { exceptionsPolicy } from './policies/exceptions.js';
import {
  pauseRateLimitedTimers,
  rateLimitPolicy,
} from './policies/rate-limit.js';
import { spawnStallPolicy } from './policies/spawn-stall.js';
import { reactStage } from './protocols/resume.js';
import { reactStageClose } from './protocols/stage-close.js';
import type { StageGateBuilder } from './protocols/stage-close.js';
import { finalPrStage } from './stages/final-pr.js';
import { implementStage } from './stages/implement.js';
import { integrateStage } from './stages/integrate.js';
import { meetingStage } from './stages/meeting.js';
import { ondemandStage } from './ondemand/index.js';
import { planningStage } from './stages/planning.js';
import type { Policy, StageModule } from './stages/types.js';

export interface EngineModules {
  stages: {
    meeting: StageModule;
    planning: StageModule;
    implement: StageModule;
    ondemand: StageModule;
    integrate: StageModule;
    'final-pr': StageModule;
  };
  policies: Policy[];
}

export const DEFAULT_MODULES: EngineModules = {
  stages: {
    meeting: meetingStage,
    planning: planningStage,
    implement: implementStage,
    ondemand: ondemandStage,
    integrate: integrateStage,
    'final-pr': finalPrStage,
  },
  policies: [
    budgetPolicy,
    exceptionsPolicy,
    spawnStallPolicy,
    rateLimitPolicy,
    cancelPolicy,
  ],
};

export type React = (state: WorkflowState, event: DomainEvent) => Effect[];

/**
 * Builds `react` from a module set (tests and the simulator inject their own).
 *
 * Contract with WorkflowRunner (§11.4): `state` is the workflow state BEFORE
 * `event` was applied; react applies it itself. An event that evolve skips
 * (duplicate, stale, foreign) yields no effects, so redelivery is harmless.
 * Effects come out in a fixed order: lifecycle, pre-gate clearing, stages in
 * pipeline order, then policies; the runner handles them in that order.
 * On resume each stage also replays what it missed while paused.
 * Timers armed for a rate-limited attempt are paused right after (S26).
 */
export const createReact =
  (modules: EngineModules): React =>
  (state, event) => {
    const applied = evolveWithWarning(state, event);
    if (applied.warning !== undefined || applied.state.workflowId === null)
      return [];
    const timer =
      event.type === 'timer.fired'
        ? state.timers[event.payload.timerId]
        : undefined;
    const ctx: ReactContext = {
      workflowId: applied.state.workflowId,
      event,
      before: state,
      state: applied.state,
      ...(timer === undefined ? {} : { timer }),
    };
    const stageGate: StageGateBuilder = (current, stageId) => {
      const kind = current.stages[stageId]?.kind;
      return kind === undefined
        ? undefined
        : modules.stages[kind].stageGate?.(current, stageId);
    };
    return pauseRateLimitedTimers(
      ctx,
      filterPolicyEffects(ctx, [
        ...reactLifecycle(ctx),
        ...reactStageClose(ctx, stageGate),
        ...Object.values(modules.stages).flatMap((stage) =>
          reactStage(stage, ctx),
        ),
        ...modules.policies.flatMap((policy) => policy(ctx)),
      ]),
    );
  };

/** `react(state, event) → Effect[]` (§11.4), pure and deterministic. */
export const react: React = createReact(DEFAULT_MODULES);
