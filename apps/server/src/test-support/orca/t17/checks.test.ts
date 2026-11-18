import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { WorkflowTemplateSchema } from '@ai-office/contracts/template';
import { WorkItemDraftSchema } from '@ai-office/contracts/events';
import {
  duplicatedFacts,
  errorAttempts,
  rateLimitReport,
  repeatedSends,
  spawnStallFalsePositives,
  statesByAgent,
  submittingAgents,
  usageByRole,
  type Json,
} from './checks.js';
import { ITEMS, TEST_TEMPLATE } from './implement-scenario.js';

const spawned = (attemptId: string, agent: string, role: string): Json => ({
  type: 'seat.spawned',
  payload: {
    attemptId,
    agent,
    role,
    stageId: 'meeting',
    purpose: 'participant',
  },
});

describe('T17 live inputs', () => {
  it('ships a valid trimmed test template and two approvable items (B depends on A)', () => {
    const template = WorkflowTemplateSchema.parse(parse(TEST_TEMPLATE));
    expect(template.stages.map((s) => s.kind)).toEqual([
      'meeting',
      'planning',
      'implement',
      'integrate',
      'final-pr',
    ]);
    const items = ITEMS.map((i) => WorkItemDraftSchema.parse(i));
    expect(items.map((i) => [i.key, i.deps])).toEqual([
      ['greeting', []],
      ['farewell', ['greeting']],
    ]);
  });
});

describe('T17 event-log checks', () => {
  const log: Json[] = [
    spawned('a1', 'claude-code', 'lead'),
    spawned('a2', 'codex', 'engineer'),
    { type: 'seat.status', payload: { attemptId: 'a1', state: 'working' } },
    { type: 'seat.status', payload: { attemptId: 'a2', state: 'working' } },
    { type: 'seat.status', payload: { attemptId: 'a2', state: 'done' } },
    {
      type: 'usage.tokens',
      payload: {
        attemptId: 'a1',
        inputUncached: 10,
        output: 5,
        cacheRead: 100,
        cacheWrite: 7,
        budgetTokens: 40,
      },
    },
    {
      type: 'usage.tokens',
      payload: {
        attemptId: 'a1',
        inputUncached: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        budgetTokens: 2,
      },
    },
    { type: 'usage.turns', payload: { attemptId: 'a1', turns: 3 } },
    {
      type: 'submission.accepted',
      payload: { submissionId: 's1', attemptId: 'a1', kind: 'statement' },
    },
    {
      type: 'submission.accepted',
      payload: { submissionId: 's2', attemptId: 'a2', kind: 'statement' },
    },
    {
      type: 'command.issued',
      attemptId: 'a2',
      payload: { kind: 'runtime.send', args: { subject: 'aio:round 2' } },
    },
  ];
  it('sums usage deltas per stage, role and agent', () => {
    expect(usageByRole(log)).toEqual([
      expect.objectContaining({
        role: 'lead',
        agent: 'claude-code',
        attempts: 1,
        inputUncached: 11,
        output: 6,
        cacheRead: 100,
        cacheWrite: 7,
        budgetTokens: 42,
        turns: 3,
      }),
    ]);
  });
  it('reports states, submitters and the absence of errors', () => {
    expect(statesByAgent(log)).toEqual({
      'claude-code': ['working'],
      codex: ['done', 'working'],
    });
    expect(submittingAgents(log)).toEqual(['claude-code', 'codex']);
    expect(errorAttempts(log)).toEqual([]);
    expect(
      errorAttempts([
        ...log,
        { type: 'seat.status', payload: { attemptId: 'a1', state: 'error' } },
      ]),
    ).toEqual(['a1']);
  });
  it('flags duplicated ingestion and repeated follow-up sends', () => {
    expect(duplicatedFacts(log)).toEqual([]);
    expect(repeatedSends(log)).toEqual([]);
    const twice = [...log, log[8]!, log[10]!];
    expect(duplicatedFacts(twice)).toEqual(['submission.accepted:s1']);
    expect(repeatedSends(twice)).toEqual(['a2|aio:round 2']);
  });
  it('counts only spawn-stall nudges and gates as stall false positives', () => {
    expect(
      spawnStallFalsePositives([
        { type: 'message.nudge', payload: { reason: 'missing-submission' } },
        { type: 'message.nudge', payload: { reason: 'spawn-stall' } },
        {
          type: 'gate.opened',
          payload: { kind: 'exception', exceptionKind: 'spawn-stall' },
        },
      ]),
    ).toEqual({ nudges: 1, gates: 1 });
  });
  it('measures rate-limit windows for S26 evidence', () => {
    const at = (iso: string, rateLimited: unknown): Json => ({
      type: 'seat.status',
      occurredAt: iso,
      payload: { attemptId: 'a1', state: 'working', rateLimited },
    });
    expect(
      rateLimitReport([
        at('2026-11-18T00:00:00Z', {
          since: '2026-11-18T00:00:00Z',
          evidence: 'worker-show',
        }),
        at('2026-11-18T00:01:00Z', null),
      ]),
    ).toEqual({ windows: 1, totalMs: 60_000, evidence: ['worker-show'] });
  });
});
