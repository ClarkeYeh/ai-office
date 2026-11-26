import type { AgentSubmission } from '@ai-office/contracts/agent-submission';
import { mainlineScenario } from '../mainline.js';
import type {
  RuntimeScenario,
  ScenarioContext,
  ScenarioStep,
} from '../scenario.js';
import {
  mainlineItems,
  PENDING_LINE,
  reviewedLine,
} from './m5-mainline-data.js';

/** Fixed synthetic directory: no clock, filesystem, network or shared M4 state. */
export const M5_FAKE_TAG = '202611240000';
export type M5Review = {
  itemKey: string;
  pr: number;
  headSha: string;
  integrationHead: string;
  integrationBranch: string;
};
export type M5ReviewFacts = {
  /** Optional fake-file model supplied by the offline acceptance binding. */
  readmeLine?: string;
  /** New worker head after the reviewer resolved a conflict on that branch. */
  resolvedHead?: string;
};

const done: ScenarioStep = { type: 'done', afterMs: 20 };
const submit = (submission: AgentSubmission): ScenarioStep[] => [
  { type: 'submit', afterMs: 10, submission },
  done,
];
const itemOf = (context: ScenarioContext) =>
  /work item `([^`]+)`/.exec(context.spec ?? '')?.[1];
const message = (context: ScenarioContext): Record<string, unknown> => {
  try {
    return JSON.parse(context.message?.body ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
};
const implement = (context: ScenarioContext): ScenarioStep[] => [
  {
    type: 'push',
    afterMs: itemOf(context) === 'sub' ? 80 : 10,
    branch: 'ai-office/example/worker',
    headSha: 'a'.repeat(40),
  },
  { type: 'done', afterMs: itemOf(context) === 'sub' ? 90 : 20 },
];

/**
 * Same five items as the joint run. Fact hooks model SCM/file inspection without
 * importing another adapter or test support. A factory isolates review history
 * per world; the restart drill kills at K, before docs has ever been reviewed.
 */
export function m5MainlineScenario(
  options: {
    tag?: string;
    inspectReview?: (review: M5Review) => M5ReviewFacts;
  } = {},
): RuntimeScenario {
  const docsReviewed = new Set<number>();
  return {
    ...mainlineScenario,
    roles: {
      ...mainlineScenario.roles,
      planner: {
        spawn: submit({
          kind: 'work-items',
          payload: {
            items: mainlineItems(options.tag ?? M5_FAKE_TAG),
          },
        }),
      },
      worker: {
        spawn: (context) => {
          const key = itemOf(context);
          if (key === 'core' || key === 'name')
            return [
              {
                type: 'ask',
                afterMs: 10,
                body:
                  key === 'core'
                    ? 'Should add() accept numeric strings? Answer yes or no.'
                    : 'Which product code name should NAME.md contain? The owner must decide.',
              },
            ];
          return implement(context);
        },
        answer: implement,
        send: implement,
      },
      oncall: {
        spawn: [done],
        send: (context) => {
          const question = message(context);
          if (typeof question.questionId !== 'string') return [done];
          return submit(
            String(question.body).includes('code name')
              ? {
                  kind: 'decision-request',
                  payload: {
                    reason: 'scope-change',
                    questionId: question.questionId,
                    question:
                      'The product code name is reserved for the owner.',
                    options: ['Owner supplies the code name'],
                  },
                }
              : {
                  kind: 'answer-question',
                  payload: {
                    questionId: question.questionId,
                    body: 'No',
                  },
                },
          );
        },
      },
      'merge-queue': {
        spawn: [done],
        send: (context) => {
          const raw = message(context);
          if (typeof raw.pr !== 'number' || typeof raw.headSha !== 'string')
            return [done];
          const review = raw as M5Review;
          const facts = options.inspectReview?.(review);
          if (review.itemKey === 'docs') {
            const line =
              facts?.readmeLine ??
              (docsReviewed.has(review.pr)
                ? reviewedLine(review.pr)
                : PENDING_LINE);
            docsReviewed.add(review.pr);
            if (line !== reviewedLine(review.pr))
              return submit({
                kind: 'rework-request',
                payload: {
                  pr: review.pr,
                  reasons: [
                    `Replace ${PENDING_LINE} with ${reviewedLine(review.pr)}; only the worker may edit this line.`,
                  ],
                },
              });
          }
          return submit({
            kind: 'merge-request',
            payload: {
              pr: review.pr,
              expectedHeadSha: facts?.resolvedHead ?? review.headSha,
            },
          });
        },
      },
      integrator: {
        spawn: (context) =>
          submit({
            kind: 'integration-report',
            payload: {
              summary:
                'Verified add, mul, sub, README and the owner-supplied code name.',
              merged: [...(context.spec ?? '').matchAll(/^- #(\d+)\b/gm)].map(
                (m) => Number(m[1]),
              ),
              verification: [
                {
                  command: `node --test m5/${options.tag ?? M5_FAKE_TAG}`,
                  ok: true,
                },
              ],
              risks: [],
            },
          }),
      },
    },
  };
}
