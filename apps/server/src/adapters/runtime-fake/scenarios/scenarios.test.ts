import { afterEach, expect, it } from 'vitest';
import { mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  office,
  closeAll,
  tempHome,
  isEnded,
} from '../../../acceptance/test-support/harness.js';
import { webScenario } from './index.js';

afterEach(closeAll);
const root = resolve(import.meta.dirname, '../../../../../..');
function home(name: string) {
  const directory = tempHome();
  mkdirSync(join(directory, 'templates'), { recursive: true });
  copyFileSync(
    join(root, `fixtures/web/templates/${name}.yaml`),
    join(directory, `templates/${name}.yaml`),
  );
  return directory;
}
it.each(['demo', 'parallel'] as const)(
  'completes %s through real HTTP and an explicit owner merge',
  { timeout: 60_000 },
  async (name) => {
    const o = await office({
      scenario: webScenario(name, 30),
      home: home(name),
    });
    const id = await o.start({ templateId: name });
    await o.drive(id, isEnded, { timeoutMs: 55_000 });
    const events = await o.events(id);
    expect(events.some((e) => e.type === 'workflow.completed')).toBe(true);
    expect(events.some((e) => e.type === 'seat.activity')).toBe(true);
    if (name === 'demo') {
      expect(
        events.some(
          (e) => e.type === 'message.answered' && e.payload.by === 'agent',
        ),
      ).toBe(true);
      expect(
        events.filter((e) => e.type === 'workitem.rework_requested'),
      ).toHaveLength(1);
    }
  },
);
it.each(['trouble', 'stall', 'load-10'] as const)(
  'exposes %s through the composed backend',
  { timeout: 60_000 },
  async (name) => {
    const o = await office({
      scenario: webScenario(name, 30),
      home: home(name),
    });
    const id = await o.start({ templateId: name });
    await o.drive(
      id,
      async (model) =>
        name === 'trouble'
          ? (await o.gates(id)).some((g) => g.kind === 'exception')
          : Object.values(model.workItems).some(
              (item) => (item as { status: string }).status === 'in_progress',
            ),
      { timeoutMs: 55_000, onException: () => true },
    );
    expect(
      (await o.events(id)).some((e) => e.type === 'workitem.dispatched'),
    ).toBe(true);
  },
);

it(
  'keeps ten attempts alive in the load fixture',
  { timeout: 30_000 },
  async () => {
    const o = await office({
      scenario: webScenario('load-10', 100),
      home: home('load-10'),
    });
    const id = await o.start({ templateId: 'load-10' });
    await o.drive(
      id,
      async () =>
        (await o.events(id)).some((e) => e.type === 'message.answered'),
      { timeoutMs: 25_000 },
    );
    // Count from observed spawns/releases rather than renderer-specific field names.
    const events = await o.events(id);
    const active = new Set<string>();
    for (const event of events) {
      if (event.type === 'seat.spawned') active.add(event.payload.attemptId);
      if (event.type === 'seat.released' || event.type === 'seat.exited')
        active.delete(event.payload.attemptId);
    }
    expect(active.size).toBe(10);
  },
);

it.each(['question', 'rework', 'lost', 'conflict'] as const)(
  'trouble reaches the %s exception',
  { timeout: 30_000 },
  async (key) => {
    const scenario = webScenario('trouble', 40);
    const o = await office({
      home: home('trouble'),
      scenario: {
        ...scenario,
        roles: {
          ...scenario.roles,
          ...(key === 'conflict'
            ? {
                merge: {
                  spawn: [{ type: 'done' as const, afterMs: 40 }],
                  send: (context: import('../scenario.js').ScenarioContext) => {
                    if (/merge fail/i.test(context.message?.body ?? '')) {
                      const send = scenario.roles.merge!.send!;
                      return typeof send === 'function' ? send(context) : send;
                    }
                    const review = JSON.parse(
                      context.message?.body ?? '{}',
                    ) as { pr?: number; headSha?: string };
                    if (!review.pr || !review.headSha) return [];
                    return [
                      {
                        type: 'submit' as const,
                        afterMs: 1000,
                        submission: {
                          kind: 'merge-request' as const,
                          payload: {
                            pr: review.pr,
                            expectedHeadSha: review.headSha,
                          },
                        },
                      },
                      { type: 'done' as const, afterMs: 1200 },
                    ];
                  },
                },
              }
            : {}),
          planner: {
            spawn: [
              {
                type: 'submit',
                afterMs: 40,
                submission: {
                  kind: 'work-items',
                  payload: {
                    items: [
                      {
                        key,
                        title: key,
                        body: key,
                        acceptance: ['Tests pass'],
                        role: 'engineer',
                        deps: [],
                      },
                    ],
                  },
                },
              },
              { type: 'done', afterMs: 80 },
            ],
          },
        },
      },
    });
    const id = await o.start({ templateId: 'trouble' });
    const wanted = {
      question: 'question-escalation',
      rework: 'rework-limit',
      lost: 'workitem-failed',
      conflict: 'merge-blocked',
    }[key];
    if (key === 'conflict') {
      await o.drive(
        id,
        async () =>
          (await o.events(id)).some(
            (event) => event.type === 'workitem.merge_queued',
          ),
        { timeoutMs: 25000 },
      );
      const number = (await o.events(id)).find(
        (event) => event.type === 'workitem.merge_queued',
      )!.payload.pr as number;
      expect(
        (
          await o.ui.call('POST', '/dev/fake/scm/pr-status', {
            number,
            mergeable: false,
          })
        ).status,
      ).toBe(200);
    }
    await o.drive(
      id,
      async () => (await o.gates(id)).some((g) => g.exceptionKind === wanted),
      { timeoutMs: 25_000, onException: () => true },
    );
    expect((await o.gates(id)).some((g) => g.exceptionKind === wanted)).toBe(
      true,
    );
  },
);
