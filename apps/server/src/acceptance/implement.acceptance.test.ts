import { afterEach, describe, expect, it } from 'vitest';
import type {
  ScenarioContext,
  ScenarioStep,
} from '../adapters/runtime-fake/index.js';
import { implementation } from '../adapters/runtime-fake/mainline-actions.js';
import { FAKE_REPO } from '../main.js';
import {
  agentRefOf,
  closeAll,
  golden,
  isEnded,
  liveAttemptsAtStageGates,
  office,
} from './test-support/harness.js';
import type { Json } from './test-support/harness.js';

afterEach(closeAll);

const of = (events: Json[], type: string, key?: string) =>
  events.filter(
    (e) => e.type === type && (key === undefined || e.payload.itemKey === key),
  );
/** The work item a worker spec names (`work item \`key\``). */
const itemOf = (context: ScenarioContext) =>
  /work item `([a-z-]+)`/.exec(context.spec ?? '')?.[1];
const submit = (submission: Json): ScenarioStep[] => [
  { type: 'submit', afterMs: 10, submission: submission as never },
  { type: 'done', afterMs: 20 },
];
/** The merge-queue review body is JSON; follow-ups (merge failures) are prose. */
const review = (context: ScenarioContext): Json | undefined => {
  try {
    return JSON.parse(context.message?.body ?? '') as Json;
  } catch {
    return undefined;
  }
};
const mergeRequest = (pr: number, headSha: string) =>
  submit({ kind: 'merge-request', payload: { pr, expectedHeadSha: headSha } });

/** Three items: `dependent` needs `feature`; `docs` is independent. */
const threeItems = {
  spawn: submit({
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
        {
          key: 'docs',
          title: 'Document it',
          body: 'Write the user guide',
          acceptance: ['Guide exists'],
          role: 'engineer',
          deps: [],
        },
      ],
    },
  }),
};

describe(
  'M1 acceptance: implement stage (progressive merge)',
  { timeout: 60_000 },
  () => {
    it('reassigns a failed work item to another agent after the work-item exception gate', async () => {
      let failed = false;
      const o = await office({
        roles: {
          worker: {
            // The first `feature` worker disappears before pushing.
            spawn: (context) =>
              itemOf(context) === 'feature' && !failed
                ? ((failed = true), [{ type: 'lost', afterMs: 10 }])
                : implementation,
          },
        },
      });
      const workflowId = await o.start();
      const exceptions: Json[] = [];
      const final = await o.drive(workflowId, isEnded, {
        onException: async (gate) => {
          exceptions.push(gate);
          const decided = await o.decide(gate, {
            decision: 'option',
            optionId: 'reassign',
            agent: 'claude-code',
          });
          expect(decided.status, JSON.stringify(decided.body)).toBe(200);
          return true;
        },
      });
      expect(final.status).toBe('completed');
      expect(
        exceptions.map((g) => [g.exceptionKind, g.content.itemKey]),
      ).toEqual([['workitem-failed', 'feature']]);
      expect(exceptions[0]!.options.map((x: Json) => x.optionId)).toEqual([
        'retry',
        'reassign',
        'skip',
        'abort',
      ]);
      const events = await o.events(workflowId);
      const dispatches = of(events, 'workitem.dispatched', 'feature');
      expect(
        dispatches.map((e) => [e.payload.attempt, e.payload.agent]),
      ).toEqual([
        [1, 'codex'],
        [2, 'claude-code'],
      ]);
      // A failed attempt retries on a new `-a<n>` branch (§7.3).
      expect(dispatches[1]!.payload.branch).toBe(
        `${dispatches[0]!.payload.branch}-a2`,
      );
      const feature = (final.workItems as Json[]).find(
        (i) => i.key === 'feature',
      )!;
      expect([feature.status, feature.agent]).toEqual([
        'merged',
        'claude-code',
      ]);
    });

    it('round-trips a rework request on the same branch and the same PR, then merges', async () => {
      let reviews = 0;
      const o = await office({
        roles: {
          'merge-queue': {
            spawn: [{ type: 'done', afterMs: 20 }],
            send: (context) => {
              const r = review(context)!;
              return r.itemKey === 'feature' && reviews++ === 0
                ? submit({
                    kind: 'rework-request',
                    payload: { pr: r.pr, reasons: ['Add a regression test'] },
                  })
                : mergeRequest(r.pr, r.headSha);
            },
          },
        },
      });
      const workflowId = await o.start();
      const final = await o.drive(workflowId, isEnded);
      expect(final.status).toBe('completed');
      const events = await o.events(workflowId);
      const rework = of(events, 'workitem.rework_requested', 'feature');
      expect(rework).toHaveLength(1);
      const dispatches = of(events, 'workitem.dispatched', 'feature');
      expect(dispatches).toHaveLength(2);
      // Same branch, same PR; the rework attempt links the rework-request.
      expect(dispatches[1]!.payload.branch).toBe(dispatches[0]!.payload.branch);
      expect(dispatches[1]!.payload.reworkOf).toBe(
        rework[0]!.payload.submissionId,
      );
      const prs = of(events, 'workitem.merge_queued', 'feature').map(
        (e) => e.payload.pr,
      );
      expect(prs).toHaveLength(2);
      expect(new Set(prs).size).toBe(1);
      // Only one PR was ever opened for the item.
      expect(
        of(events, 'workitem.status', 'feature').filter((e) => e.payload.pr)
          .length,
      ).toBe(1);
      const feature = (final.workItems as Json[]).find(
        (i) => i.key === 'feature',
      )!;
      expect([feature.status, feature.reworks, feature.attempts]).toEqual([
        'merged',
        1,
        2,
      ]);
      expect(golden(events)).toContain('workitem.rework_requested feature');
    });

    it('opens rework-limit and dependency exception gates while on-demand instances keep merging other items', async () => {
      let rounds = 0;
      const o = await office({
        roles: {
          planner: threeItems,
          // `docs` waits until the test releases it (see below).
          worker: {
            spawn: (context) =>
              itemOf(context) === 'docs' ? [] : implementation,
          },
          'merge-queue': {
            spawn: [{ type: 'done', afterMs: 20 }],
            // Always sends `feature` back; merges everything else. Each round
            // gives new reasons: identical content is an idempotent replay.
            send: (context) => {
              const r = review(context)!;
              return r.itemKey === 'feature'
                ? submit({
                    kind: 'rework-request',
                    payload: {
                      pr: r.pr,
                      reasons: [`Still missing tests (round ${++rounds})`],
                    },
                  })
                : mergeRequest(r.pr, r.headSha);
            },
          },
        },
      });
      const workflowId = await o.start();
      const exceptions: Json[] = [];
      const final = await o.drive(workflowId, isEnded, {
        onException: async (gate) => {
          exceptions.push(gate);
          if (gate.exceptionKind === 'rework-limit') {
            // While the item gate is open, `docs` pushes and the merge queue
            // (an on-demand instance) still reviews and merges it.
            const docs = (await o.events(workflowId)).find(
              (e) =>
                e.type === 'workitem.dispatched' &&
                e.payload.itemKey === 'docs',
            )!;
            o.world.runtime.enqueue(
              agentRefOf(await o.events(workflowId), docs.payload.attemptId),
              ...implementation,
            );
            const merged = await o.drive(
              workflowId,
              (w) =>
                (w.workItems as Json[]).some(
                  (i) => i.key === 'docs' && i.status === 'merged',
                ),
              { onException: () => true },
            );
            expect(merged.status).toBe('running');
          }
          await o.decide(gate, { decision: 'option', optionId: 'skip' });
          return true;
        },
      });
      expect(final.status).toBe('completed');
      expect(
        exceptions.map((g) => [g.exceptionKind, g.content.itemKey]),
      ).toEqual([
        ['rework-limit', 'feature'],
        ['dependency-blocked', 'dependent'],
      ]);
      expect(exceptions[1]!.options.map((x: Json) => x.optionId)).toEqual([
        'proceed',
        'skip',
        'abort',
      ]);
      const events = await o.events(workflowId);
      // maxRework is 2: the third rework request is the one that exceeds it.
      expect(of(events, 'workitem.rework_requested', 'feature')).toHaveLength(
        3,
      );
      expect(of(events, 'workitem.dispatched', 'dependent')).toEqual([]);
      expect((final.workItems as Json[]).map((i) => [i.key, i.status])).toEqual(
        [
          ['feature', 'skipped'],
          ['dependent', 'skipped'],
          ['docs', 'merged'],
        ],
      );
      // The merge-queue instance was alive while the rework-limit gate was open.
      const limitGate = events.find(
        (e) =>
          e.type === 'gate.opened' &&
          e.payload.exceptionKind === 'rework-limit',
      )!;
      const docsMerged = of(events, 'workitem.merged', 'docs')[0]!;
      expect(docsMerged.seq).toBeGreaterThan(limitGate.seq);
      expect(
        liveAttemptsAtStageGates(events).every((g) => g.live.length === 0),
      ).toBe(true);
    });

    it('merges after the integrator resolves a merge-queue conflict, and opens merge-blocked when it cannot', async () => {
      const repo = FAKE_REPO.github;
      const pending: Record<string, Json> = {};
      const o = await office({
        roles: {
          'merge-queue': {
            spawn: [{ type: 'done', afterMs: 20 }],
            send: (context) => {
              const r = review(context);
              if (r) {
                // Every PR conflicts with the integration branch at first.
                pending[r.itemKey] = r;
                o.world.scm.setMergeable({ repo, number: r.pr }, false);
                return mergeRequest(r.pr, r.headSha);
              }
              const key = /Review (\S+)/.exec(context.message!.subject)![1]!;
              const failed = pending[key]!;
              if (key === 'feature') {
                // Resolves on the worker branch and merges the new head.
                const pr = o.world.scm.inspectObject({
                  repo,
                  number: failed.pr,
                });
                const head = o.world.scm.pushBranch(repo, pr.head!);
                o.world.scm.setMergeable({ repo, number: failed.pr }, true);
                return mergeRequest(failed.pr, head);
              }
              return submit({
                kind: 'decision-request',
                payload: {
                  reason: 'unresolvable-conflict',
                  question: 'Both branches rewrite the same module',
                  options: ['Rework on top of the integration branch'],
                },
              });
            },
          },
        },
      });
      const workflowId = await o.start();
      const exceptions: Json[] = [];
      const final = await o.drive(workflowId, isEnded, {
        onException: async (gate) => {
          exceptions.push(gate);
          await o.decide(gate, { decision: 'option', optionId: 'skip' });
          return true;
        },
      });
      expect(final.status).toBe('completed');
      const events = await o.events(workflowId);
      const failures = events.filter(
        (e) => e.type === 'command.failed' && e.payload.kind === 'scm.mergePR',
      );
      expect(failures.map((e) => e.payload.error.code)).toEqual([
        'pr_not_mergeable',
        'pr_not_mergeable',
      ]);
      expect(
        exceptions.map((g) => [g.exceptionKind, g.content.itemKey]),
      ).toEqual([['merge-blocked', 'dependent']]);
      expect((final.workItems as Json[]).map((i) => [i.key, i.status])).toEqual(
        [
          ['feature', 'merged'],
          ['dependent', 'skipped'],
        ],
      );
    });

    it('routes worker questions to the on-call lead, and its decision request to a human', async () => {
      let asked = 0;
      const o = await office({
        roles: {
          worker: {
            spawn: () => [
              {
                type: 'ask',
                afterMs: 5,
                body: asked++ === 0 ? 'Which flag name?' : 'Change the scope?',
              },
            ],
            answer: implementation,
          },
          oncall: {
            spawn: [{ type: 'done', afterMs: 5 }],
            send: (context) => {
              const question = JSON.parse(context.message!.body) as Json;
              return question.body === 'Which flag name?'
                ? submit({
                    kind: 'answer-question',
                    payload: {
                      questionId: question.questionId,
                      body: 'Use darkMode',
                    },
                  })
                : submit({
                    kind: 'decision-request',
                    payload: {
                      reason: 'scope-change',
                      question: 'The owner must decide the scope',
                      options: ['Keep the scope'],
                      questionId: question.questionId,
                    },
                  });
            },
          },
        },
      });
      const workflowId = await o.start();
      const escalated: Json[] = [];
      const final = await o.drive(workflowId, isEnded, {
        onException: async (gate) => {
          expect(gate.exceptionKind).toBe('question-escalation');
          // Escalated questions are answered in the inbox, not via the gate.
          const viaGate = await o.decide(gate, {
            decision: 'option',
            optionId: 'abort',
          });
          expect(viaGate.status).toBe(422);
          const { questions } = (await o.ui.call('GET', '/api/v1/questions'))
            .body as { questions: Json[] };
          const question = questions.find((q) => q.status === 'escalated')!;
          escalated.push(question);
          const answered = await o.ui.call(
            'POST',
            `/api/v1/questions/${encodeURIComponent(question.questionId)}/answer`,
            { body: 'Keep the scope' },
          );
          expect(answered.status, JSON.stringify(answered.body)).toBe(200);
          return true;
        },
      });
      expect(final.status).toBe('completed');
      const questions = final.questions as Json[];
      expect(
        questions.map((q) => [q.itemKey, q.status, q.forwardedTo, q.answer.by]),
      ).toEqual([
        ['feature', 'answered', 'on-call', 'agent'],
        ['dependent', 'answered', 'on-call', 'user'],
      ]);
      expect(escalated[0]!.escalation.reason).toBe('decision-request');
      const events = await o.events(workflowId);
      expect(
        events
          .filter((e) => e.type === 'ondemand.started')
          .map((e) => e.payload.purpose)
          .sort(),
      ).toEqual(['merge', 'oncall']);
      // Workers received both answers through the runtime.
      expect(
        events.filter(
          (e) =>
            e.type === 'command.succeeded' &&
            e.payload.kind === 'runtime.answer',
        ).length,
      ).toBe(2);
    });
  },
);
