import type {
  RuntimeScenario,
  ScenarioContext,
  ScenarioStep,
} from '../scenario.js';

type Submission = Extract<ScenarioStep, { type: 'submit' }>['submission'];
export type WebScenarioName =
  'demo' | 'parallel' | 'trouble' | 'load-10' | 'stall';
const message = (context: ScenarioContext): Record<string, unknown> => {
  try {
    return JSON.parse(context.message?.body ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Public DSL only; review history is isolated by workflow ID. */
export function webScenario(
  name: WebScenarioName,
  pace = 1000,
): RuntimeScenario {
  const reviewed = new Set<string>();
  const done: ScenarioStep = { type: 'done', afterMs: pace * 2 };
  const submit = (submission: Submission): ScenarioStep => ({
    type: 'submit',
    submission,
    afterMs: pace,
  });
  const activity = (duration: number): ScenarioStep[] =>
    Array.from({ length: duration }, (_, i) => ({
      type: 'output',
      afterMs: pace * (i + 1),
      blocks: [
        {
          type: 'tool_use',
          id: `tool-${i}`,
          name: ['Read', 'Edit', 'Bash', 'Git', 'WebFetch'][i % 5]!,
          input: i % 5 === 3 ? { command: 'git status' } : {},
        },
      ],
    }));
  const work = (): ScenarioStep[] => [
    ...activity(4),
    {
      type: 'push',
      branch: 'ai-office/demo/work',
      headSha: 'a'.repeat(40),
      afterMs: pace * 5,
    },
    { type: 'done', afterMs: pace * 6 },
  ];
  const statement = (context: ScenarioContext): ScenarioStep[] => {
    const round = Number(
      message(context).round ??
        /round (\d+)/.exec(context.message?.body ?? '')?.[1] ??
        1,
    );
    return [
      submit({
        kind: 'statement',
        payload: {
          round,
          position: 'Proceed',
          arguments: ['Keep the change testable'],
          concerns: [],
          readyToConclude: round >= 2,
        },
      }),
      done,
    ];
  };
  const keys =
    name === 'parallel'
      ? ['one', 'two', 'three', 'four', 'dependent']
      : name === 'load-10'
        ? Array.from({ length: 9 }, (_, i) => `load-${i + 1}`)
        : name === 'trouble'
          ? ['lost', 'policy', 'question', 'rework', 'conflict']
          : ['feature', 'dependent'];
  return {
    role: (request, spec) => {
      const title =
        /^# AI Office spec: (.*)$/m.exec(spec ?? '')?.[1] ?? request.title;
      return (
        (
          [
            ['meeting facilitator', 'facilitator'],
            ['meeting participant', 'participant'],
            ['planning lead', 'planner'],
            ['implementation worker', 'worker'],
            ['merge-queue integrator', 'merge'],
            ['integrator (wrap-up)', 'integrator'],
            ['on-call lead', 'oncall'],
          ] as const
        ).find(([pattern]) => title.includes(pattern))?.[1] ?? title
      );
    },
    roles: {
      facilitator: {
        spawn: [
          submit({
            kind: 'agenda',
            payload: {
              topics: [
                {
                  id: 'design',
                  title: 'Design',
                  focusByRole: {
                    pm: 'Scope',
                    architect: 'Architecture',
                    engineer: 'Tests',
                  },
                },
              ],
            },
          }),
          done,
        ],
        send: (context) =>
          /conclusion/i.test(
            `${context.message?.subject} ${context.message?.body}`,
          )
            ? [
                submit({
                  kind: 'conclusion',
                  payload: {
                    summary: 'Deliver the office demo',
                    decisions: [
                      { title: 'Small changes', rationale: 'Easy to verify' },
                    ],
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
              ]
            : statement(context),
      },
      participant: { spawn: [done], send: statement },
      planner: {
        spawn: [
          submit({
            kind: 'work-items',
            payload: {
              items: keys.map((key) => ({
                key,
                title: `Implement ${key}`,
                body: `Deliver ${key}`,
                acceptance: ['Tests pass'],
                role: 'engineer',
                deps: key === 'dependent' ? [keys[0]!] : [],
              })),
            },
          }),
          done,
        ],
      },
      worker: {
        // M2-T14: a silent role is spawned but never acts (§7.1 spawn stall).
        ...(name === 'stall' ? { silent: true } : {}),
        spawn: (context) => {
          if (name === 'load-10')
            return /Work item `load-1`/.test(context.spec ?? '')
              ? [
                  {
                    type: 'ask',
                    body: 'Confirm load instrumentation',
                    afterMs: pace,
                  },
                ]
              : activity(75);
          const spec = context.spec ?? '';
          if (name === 'trouble') {
            if (/Work item `lost`/.test(spec))
              return [
                { type: 'degraded', reason: 'source_changed', afterMs: pace },
                { type: 'lost', afterMs: pace * 2 },
              ];
            if (/Work item `policy`/.test(spec))
              return [
                {
                  type: 'policy',
                  command: 'git push origin main',
                  afterMs: pace,
                },
              ];
            if (/Work item `question`/.test(spec))
              return [
                {
                  type: 'ask',
                  body: 'Which behavior should we ship?',
                  afterMs: pace,
                },
              ];
          }
          if (
            name === 'demo' &&
            /Work item `feature`/.test(spec) &&
            !/Rework work item/.test(spec)
          )
            return [
              ...activity(2),
              {
                type: 'ask',
                body: 'Should this include a regression test?',
                afterMs: pace * 3,
              },
            ];
          return work();
        },
        answer: () => (name === 'load-10' ? activity(75) : work()),
        send: work,
      },
      oncall: {
        spawn: [done],
        send: (context) => {
          const questionId = message(context).questionId;
          if (typeof questionId !== 'string') return [done];
          if (name === 'load-10')
            return [
              submit({
                kind: 'answer-question',
                payload: { questionId, body: 'Instrumentation is ready.' },
              }),
              ...activity(75),
            ];
          return [
            submit(
              name === 'trouble'
                ? {
                    kind: 'decision-request',
                    payload: {
                      reason: 'scope-change',
                      question: 'Choose the expected behavior',
                      options: ['Keep existing behavior', 'Change behavior'],
                      questionId,
                    },
                  }
                : {
                    kind: 'answer-question',
                    payload: {
                      questionId,
                      body: 'Yes, include a regression test.',
                    },
                  },
            ),
            done,
          ];
        },
      },
      merge: {
        spawn: [done],
        send: (context) => {
          if (
            name === 'trouble' &&
            /merge fail/i.test(context.message?.body ?? '')
          )
            return [
              submit({
                kind: 'decision-request',
                payload: {
                  reason: 'unresolvable-conflict',
                  question: 'The conflict needs an owner decision',
                  options: ['Retry after resolving the conflict'],
                },
              }),
              done,
            ];
          const review = message(context);
          if (
            typeof review.pr !== 'number' ||
            typeof review.headSha !== 'string'
          )
            return [done];
          const reviewKey =
            context.request.correlation.workflowId + '/' + review.pr;
          if (
            (name === 'demo' &&
              review.itemKey === 'feature' &&
              !reviewed.has(reviewKey)) ||
            (name === 'trouble' && review.itemKey === 'rework')
          ) {
            reviewed.add(reviewKey);
            return [
              submit({
                kind: 'rework-request',
                payload: {
                  pr: review.pr,
                  reasons: ['Add the regression test'],
                },
              }),
              done,
            ];
          }
          return [
            submit({
              kind: 'merge-request',
              payload: { pr: review.pr, expectedHeadSha: review.headSha },
            }),
            done,
          ];
        },
      },
      integrator: {
        spawn: [
          submit({
            kind: 'integration-report',
            payload: {
              summary: 'Verified demo',
              merged: [],
              verification: [{ command: 'pnpm test', ok: true }],
              risks: [],
            },
          }),
          done,
        ],
      },
    },
  };
}
export const demoScenario = webScenario('demo');
export const parallelScenario = webScenario('parallel');
export const troubleScenario = webScenario('trouble');
export const load10Scenario = webScenario('load-10');
export const stallScenario = webScenario('stall');
