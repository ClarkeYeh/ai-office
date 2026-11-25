import { createReact, DEFAULT_MODULES } from '../react.js';
import type { AgentSubmission } from '@ai-office/domain';
import { cooperativeWorld, Simulator } from './simulator.js';
import type { Observation, World } from './simulator.js';
import { startWorkflow } from './fixtures.js';
const conclusion: AgentSubmission = {
  kind: 'conclusion',
  payload: {
    summary: 'Build the feature',
    decisions: [],
    techDecisions: [],
    openQuestions: [],
  },
};
const agenda: AgentSubmission = {
  kind: 'agenda',
  payload: {
    topics: [
      {
        id: 'design',
        title: 'Design',
        focusByRole: { pm: 'Scope', architect: 'Design', engineer: 'Tests' },
      },
    ],
  },
};
const items: AgentSubmission = {
  kind: 'work-items',
  payload: {
    items: [
      {
        key: 'A',
        title: 'Build',
        body: 'Build feature',
        acceptance: ['Works'],
        role: 'engineer',
        deps: [],
      },
      {
        key: 'B',
        title: 'Test',
        body: 'Test feature',
        acceptance: ['Passes'],
        role: 'engineer',
        deps: ['A'],
      },
    ],
  },
};
export interface Scenario {
  early?: boolean;
  absent?: string[];
  missingConclusion?: boolean;
  missingAgenda?: boolean;
  dirty?: boolean;
  planning?: boolean;
  missingItems?: boolean;
  /** This role's releases fail permanently. */
  releaseFails?: string;
  /** ...and its stops are ignored, so the agent stays alive. */
  stuck?: boolean;
}
export const scenario =
  (options: Scenario = {}): World =>
  (issued, sim) => {
    const base = cooperativeWorld(issued, sim)!;
    const attempt = issued.attemptId
      ? sim.state.attempts[issued.attemptId]
      : undefined;
    const done: Observation[] = attempt
      ? [
          {
            type: 'ObserveAttemptStatus',
            attemptId: attempt.attemptId,
            state: 'done',
          },
        ]
      : [];
    const submit = (submission: AgentSubmission): Observation => ({
      type: 'AcceptSubmission',
      attemptId: attempt!.attemptId,
      submissionId: `submission-${sim.events.length}`,
      artifactId: `artifact-${sim.events.length}`,
      submission,
    });
    if (attempt?.role === options.releaseFails) {
      if (issued.command.kind === 'runtime.release')
        return {
          ok: false,
          error: {
            category: 'permanent',
            code: 'release_failed',
            message: 'Release failed',
            retryable: false,
          },
        };
      if (issued.command.kind === 'runtime.stop' && options.stuck)
        return { ok: true, result: {} };
    }
    if (issued.command.kind === 'runtime.inspectWorkspace' && options.dirty)
      return {
        ok: true,
        result: { clean: false, changedFiles: ['changed.ts'] },
      };
    if (issued.command.kind === 'runtime.spawnAgent') {
      if (attempt?.purpose === 'facilitator')
        return {
          ...base,
          observe: [
            ...(options.missingAgenda ? [] : [submit(agenda)]),
            ...done,
          ],
        };
      if (attempt?.purpose === 'participant') return { ...base, observe: done };
      if (attempt?.purpose === 'planner' && options.planning)
        return {
          ...base,
          observe: [...(options.missingItems ? [] : [submit(items)]), ...done],
        };
    }
    if (issued.command.kind === 'runtime.send') {
      const subject = issued.command.args.subject;
      if (subject.startsWith('Meeting round') && attempt) {
        if (options.absent?.includes(attempt.role))
          return { ...base, observe: done };
        const round = Number(subject.split(' ').at(-1));
        return {
          ...base,
          observe: [
            submit({
              kind: 'statement',
              payload: {
                round,
                position: 'Proceed',
                arguments: ['Feasible'],
                concerns: [],
                readyToConclude: options.early ?? false,
              },
            }),
            ...done,
          ],
        };
      }
      if (subject === 'Write meeting conclusion')
        return {
          ...base,
          observe: [
            ...(options.missingConclusion ? [] : [submit(conclusion)]),
            ...done,
          ],
        };
    }
    return base;
  };
export const runMeeting = (options: Scenario = {}, auto = false) => {
  const sim = new Simulator({
    world: scenario(options),
    react: createReact({
      ...DEFAULT_MODULES,
      stages: { ...DEFAULT_MODULES.stages, implement: { react: () => [] } },
    }),
  });
  const start = startWorkflow();
  if (auto) start.gateToggles = { conclusion: false, 'task-split': false };
  sim.dispatch(start);
  return sim;
};
