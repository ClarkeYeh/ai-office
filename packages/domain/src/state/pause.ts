import type { Timer, Workflow, WorkflowState } from './types.js';

/**
 * FX8b: milliseconds the workflow was paused between `since` and `until`.
 * A pause runs from its first reason to full unpause, however many reasons
 * overlap, so each window counts once.
 */
export const pausedMilliseconds = (
  workflow: Workflow | null,
  since: string,
  until: string,
): number => {
  const from = Date.parse(since);
  const to = Date.parse(until);
  let total = 0;
  for (const window of workflow?.pauseWindows ?? []) {
    const start = Math.max(from, Date.parse(window.from));
    const stop = Math.min(to, Date.parse(window.to ?? until));
    if (stop > start) total += stop - start;
  }
  return total;
};

const END_OF_TIME = new Date(8.64e15).toISOString();

/**
 * Pause time a timer has not yet been credited: paused since it was
 * scheduled. Read only while unpaused, when every window is closed.
 */
const owedMilliseconds = (state: WorkflowState, timer: Timer): number =>
  pausedMilliseconds(
    state.workflow,
    timer.scheduledAt ?? END_OF_TIME,
    END_OF_TIME,
  );

/**
 * FX8b: a pending timer a workflow pause stopped. It never fires while held:
 * the workflow is still paused, or the pause has ended and the timer waits
 * for its rescheduled `fireAt`.
 */
export const isTimerHeld = (state: WorkflowState, timer: Timer): boolean =>
  (state.workflow?.pausedReasons.length ?? 0) > 0 ||
  owedMilliseconds(state, timer) > 0;

/**
 * FX8b: once the workflow is unpaused, the timers its pauses held, in id
 * order, each with the `fireAt` that gives it back its remaining time:
 * `fireAt + paused time since it was scheduled`, never earlier than `now`.
 */
export const heldTimerShifts = (
  state: WorkflowState,
  now: string,
): { timer: Timer; fireAt: string }[] => {
  if (
    state.workflow?.status !== 'running' ||
    state.workflow.pausedReasons.length
  )
    return [];
  return Object.values(state.timers)
    .map((timer) => ({ timer, owed: owedMilliseconds(state, timer) }))
    .filter(({ owed }) => owed > 0)
    .sort((a, b) => (a.timer.id < b.timer.id ? -1 : 1))
    .map(({ timer, owed }) => ({
      timer,
      fireAt: new Date(
        Math.max(Date.parse(now), Date.parse(timer.fireAt) + owed),
      ).toISOString(),
    }));
};
