import type { DomainEvent } from '@ai-office/contracts/events';
import type { ReactContext } from '../context.js';
import type { Effect } from '../effects.js';
import type { StageGateBuilder } from '../protocols/stage-close.js';

/**
 * One stage partition (plan §5.1: meeting/planning T13, implement T14, ondemand T14b,
 * integrate/final-pr T15). `react` sees every event and filters for itself;
 * gated stages also supply the stage gate opened after pre-gate clearing.
 * `resume` rebuilds the events the stage ignored while paused and must still
 * act on; they are replayed when the workflow resumes (protocols/resume.ts).
 */
export interface StageModule {
  react: (ctx: ReactContext) => Effect[];
  stageGate?: StageGateBuilder;
  resume?: (ctx: ReactContext) => DomainEvent[];
}

/** A cross-stage policy (T16): budget, exception-gate handling, cancel. */
export type Policy = (ctx: ReactContext) => Effect[];
