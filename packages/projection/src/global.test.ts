import { expect, test } from 'vitest';
import {
  GatesResponseSchema,
  HealthViewSchema,
  ReposResponseSchema,
  WorkflowsResponseSchema,
} from '@ai-office/contracts/api';
import { evolveGlobal, initialGlobalReadModel } from './index.js';
import { event, payloads, at } from './test-support/events.js';
import { prepared } from './test-support/scenario.js';

test('global views isolate workflows and aggregate inbox, questions and summaries', () => {
  const s = prepared();
  s.push('message.escalated');
  let global = s.events.reduce(evolveGlobal, initialGlobalReadModel('fake'));
  expect(global.health.runtime.mode).toBe('fake');
  expect(global.gateInbox).toHaveLength(2);
  expect(global.escalatedQuestions).toHaveLength(1);
  expect(global.workflowList[0]).toMatchObject({
    openGates: 2,
    escalatedQuestions: 1,
    repoFullName: 'octo/demo',
    currentStageKind: 'integrate',
  });
  global = evolveGlobal(
    global,
    event('workflow.started', 100, undefined, 'wf2'),
  );
  global = evolveGlobal(
    global,
    event('workflow.completed', 101, undefined, 'wf2'),
  );
  expect(global.workflowList[1]).toMatchObject({
    status: 'completed',
    endedAt: at,
    currentStageKind: null,
  });
  expect(global.workflowList[0]?.status).toBe('running');
  global = evolveGlobal(
    global,
    event('gate.closed', 102, { gateId: 'g1', reason: 'cancelled' }),
  );
  global = evolveGlobal(global, event('message.answered', 103));
  expect(global.gateInbox).toHaveLength(1);
  expect(global.escalatedQuestions).toHaveLength(0);
  expect(evolveGlobal(global, event('workflow.cancelled', 1))).toBe(global);
  WorkflowsResponseSchema.parse({ workflows: global.workflowList });
  GatesResponseSchema.parse({ gates: global.gateInbox });
});

test('repo facts and health banners follow system events without inventing unknown repos', () => {
  let m = initialGlobalReadModel();
  let seq = 0;
  const push = (type: Parameters<typeof event>[0], payload?: unknown) =>
    (m = evolveGlobal(m, event(type, ++seq, payload, null)));
  push('repo.updated');
  expect(m.repos).toEqual([]);
  push('repo.registered');
  push('repo.registered');
  expect(m.repos).toHaveLength(1);
  push('repo.updated');
  expect(m.repos[0]).toMatchObject({
    status: 'invalid',
    issues: ['Not in Orca'],
  });
  push('health.changed');
  expect(m.health.runtime.breaker).toBe('half_open');
  push('health.changed', {
    component: 'runtime',
    status: 'unhealthy',
    runtimeVerified: true,
    detail: 'offline',
  });
  expect(m.health.status).toBe('unhealthy');
  expect(m.health.runtime.verified).toBe(true);
  for (const component of ['runtime', 'scm', 'store', 'usage'])
    push('health.changed', { component, status: 'healthy', breaker: 'closed' });
  expect(m.health.status).toBe('healthy');
  expect(m.health.runtime.detail).toBeUndefined();
  push('runtime.identity_hijacked');
  expect(m.health.runtime.runOwned).toBe(false);
  expect(m.health.status).toBe('unhealthy');
  push('runtime.identity_restored');
  expect(m.health.runtime).toMatchObject({
    runOwned: true,
    shim: { status: 'ok', location: 'term_2' },
  });
  // Restoration is identity evidence; health.changed is the authoritative health observation.
  expect(m.health.status).toBe('unhealthy');
  HealthViewSchema.parse(m.health);
  ReposResponseSchema.parse({ repos: m.repos });
});

test('unusual ids are own dictionary keys, never prototype properties', () => {
  let m = initialGlobalReadModel();
  m = evolveGlobal(m, event('seat.spawned', 1, undefined, 'constructor'));
  expect(m.workflows).toEqual({});
  m = evolveGlobal(m, event('workflow.started', 2, undefined, '__proto__'));
  expect(Object.hasOwn(m.workflows, '__proto__')).toBe(true);
  expect(m.workflowList[0]?.workflowId).toBe('__proto__');
  const start = {
    ...payloads['workflow.started'],
    budgets: { stages: {}, hardLimitMultiplier: 2 },
  };
  m = evolveGlobal(m, event('workflow.started', 3, start, 'constructor'));
  expect(m.workflowList).toHaveLength(2);
});
