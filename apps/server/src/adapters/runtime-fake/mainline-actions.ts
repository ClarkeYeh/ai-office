import type { AgentSubmission } from '@ai-office/contracts/agent-submission';
import type { RoleBehavior, ScenarioStep } from './scenario.js';
const submit = (submission: AgentSubmission): ScenarioStep => ({
  type: 'submit',
  afterMs: 10,
  submission,
});
const done: ScenarioStep = { type: 'done', afterMs: 20 };
export const statement = (round: number): ScenarioStep[] => [
  submit({
    kind: 'statement',
    payload: {
      round,
      position: 'Proceed',
      arguments: ['Fits scope'],
      concerns: [],
      readyToConclude: round === 2,
    },
  }),
  done,
];
export const agenda = [
  submit({
    kind: 'agenda',
    payload: {
      topics: [
        {
          id: 'design',
          title: 'Design',
          focusByRole: {
            pm: 'Scope',
            architect: 'Design',
            engineer: 'Implementation',
          },
        },
      ],
    },
  }),
  done,
];
export const conclusion = [
  submit({
    kind: 'conclusion',
    payload: {
      summary: 'Implement the agreed feature',
      decisions: [{ title: 'Small delivery', rationale: 'Testable scope' }],
      techDecisions: [
        {
          topic: 'Language',
          options: ['TypeScript'],
          chosen: 'TypeScript',
          rationale: 'Existing stack',
        },
      ],
      openQuestions: [],
    },
  }),
  done,
];
export const planning = [
  submit({
    kind: 'work-items',
    payload: {
      items: [
        {
          key: 'feature',
          title: 'Implement feature',
          body: 'Implement the approved conclusion',
          acceptance: ['Tests pass'],
          role: 'engineer',
          deps: [],
        },
        {
          key: 'dependent',
          title: 'Use the feature',
          body: 'Build on the merged feature',
          acceptance: ['Feature is available'],
          role: 'engineer',
          deps: ['feature'],
        },
      ],
    },
  }),
  done,
];
export const implementation: ScenarioStep[] = [
  {
    type: 'push',
    afterMs: 10,
    branch: 'ai-office/example/feature',
    headSha: 'a'.repeat(40),
  },
  done,
];
export const integration: ScenarioStep[] = [
  {
    type: 'submit',
    afterMs: 20,
    submission: {
      kind: 'integration-report',
      payload: {
        summary: 'Verified',
        merged: [1, 2],
        verification: [{ command: 'pnpm test', ok: true }],
        risks: [],
      },
    },
  },
  { type: 'done', afterMs: 30 },
];
export const participant: RoleBehavior = {
  spawn: statement(1),
  send: statement(2),
};
export const facilitator: RoleBehavior = {
  spawn: agenda,
  send: (context) =>
    context.turn <= 3 ? statement(context.turn - 1) : conclusion,
};

/** Each send carries the application's current PR/head; rework keeps that PR. */
export const mergeQueue: RoleBehavior = {
  spawn: [done],
  send: (context) => {
    const review = JSON.parse(context.message?.body ?? '{}') as {
      pr: number;
      expectedHeadSha: string;
      rework?: boolean;
    };
    return [
      submit(
        review.rework
          ? {
              kind: 'rework-request',
              payload: {
                pr: review.pr,
                reasons: ['Add the missing regression test'],
              },
            }
          : {
              kind: 'merge-request',
              payload: {
                pr: review.pr,
                expectedHeadSha: review.expectedHeadSha,
              },
            },
      ),
      done,
    ];
  },
};
