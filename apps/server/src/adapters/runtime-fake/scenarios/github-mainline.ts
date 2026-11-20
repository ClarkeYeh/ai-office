import { mainlineScenario } from '../mainline.js';
import { implementation } from '../mainline-actions.js';
import type {
  RuntimeScenario,
  ScenarioContext,
  ScenarioStep,
} from '../scenario.js';

const done: ScenarioStep = { type: 'done', afterMs: 20 };
const submit = (
  submission: Extract<ScenarioStep, { type: 'submit' }>['submission'],
): ScenarioStep[] => [{ type: 'submit', afterMs: 10, submission }, done];
const message = (context: ScenarioContext): Record<string, unknown> => {
  try {
    return JSON.parse(context.message?.body ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Fresh per world: all review history is scoped by workflow, never shared with M4. */
export function githubMainlineScenario(): RuntimeScenario {
  const reviewed = new Set<string>();
  return {
    ...mainlineScenario,
    roles: {
      ...mainlineScenario.roles,
      worker: {
        spawn: (context) =>
          /Implement work item `feature`/.test(context.spec ?? '')
            ? [
                {
                  type: 'ask',
                  afterMs: 10,
                  body: 'Should the synthetic change include a regression check?',
                },
              ]
            : implementation,
        answer: implementation,
        send: implementation,
      },
      oncall: {
        spawn: [done],
        send: (context) => {
          const questionId = message(context).questionId;
          return typeof questionId === 'string'
            ? submit({
                kind: 'answer-question',
                payload: {
                  questionId,
                  body: 'Yes, include the regression check.',
                },
              })
            : [done];
        },
      },
      'merge-queue': {
        spawn: [done],
        send: (context) => {
          const review = message(context);
          if (
            typeof review.pr !== 'number' ||
            typeof review.headSha !== 'string'
          )
            return [done];
          const workflow =
            /workflow `([^`]+)`/.exec(context.spec ?? '')?.[1] ??
            context.session;
          const key = `${workflow}:${String(review.itemKey)}`;
          if (!reviewed.has(key)) {
            reviewed.add(key);
            if (review.itemKey === 'feature')
              return submit({
                kind: 'rework-request',
                payload: {
                  pr: review.pr,
                  reasons: ['Add the missing synthetic regression check'],
                },
              });
            if (review.itemKey === 'dependent')
              return submit({
                kind: 'decision-request',
                payload: {
                  reason: 'unresolvable-conflict',
                  question:
                    'Synthetic review failed; retry this item on a fresh branch.',
                  options: ['Retry'],
                },
              });
          }
          return submit({
            kind: 'merge-request',
            payload: { pr: review.pr, expectedHeadSha: review.headSha },
          });
        },
      },
      integrator: {
        spawn: (context) => [
          {
            type: 'push',
            branch: 'ai-office/example/integration',
            headSha: 'b'.repeat(40),
            afterMs: 10,
          },
          {
            type: 'submit',
            afterMs: 20,
            submission: {
              kind: 'integration-report',
              payload: {
                summary:
                  'Applied one synthetic fix-forward commit and verified the integration.',
                merged: [...(context.spec ?? '').matchAll(/^- #(\d+)\b/gm)].map(
                  (match) => Number(match[1]),
                ),
                verification: [
                  { command: 'synthetic regression check', ok: true },
                ],
                risks: [],
              },
            },
          },
          { type: 'done', afterMs: 30 },
        ],
      },
    },
  };
}
