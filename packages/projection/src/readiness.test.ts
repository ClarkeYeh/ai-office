import { describe, expect, test } from 'vitest';
import type { WorkItemStatus } from '@ai-office/contracts/events';
import { blockedByOf, isReady, type ReadModel } from './index.js';
import { scenario } from './test-support/scenario.js';

// Copied from the domain's dispatch readiness cases (packages/domain/src/decide:
// `workItemDependencies`, `dependencyOverride`, `dependencies_not_ready` rows) so the
// read-side helper and the domain rule stay in step without importing the domain.
type Row = {
  name: string;
  items: Record<string, { status: WorkItemStatus; deps?: string[] }>;
  override?: { itemKey: string; optionId: string };
  key?: string;
  blockedBy: string[];
  ready: boolean;
};
const rows: Row[] = [
  {
    name: 'no dependencies',
    items: { A: { status: 'approved' } },
    blockedBy: [],
    ready: true,
  },
  {
    name: 'merged dependency',
    items: { A: { status: 'approved', deps: ['B'] }, B: { status: 'merged' } },
    blockedBy: [],
    ready: true,
  },
  {
    name: 'PR open is not ready',
    items: { A: { status: 'approved', deps: ['B'] }, B: { status: 'pr_open' } },
    blockedBy: ['B'],
    ready: false,
  },
  {
    name: 'in review is not ready',
    items: {
      A: { status: 'approved', deps: ['B'] },
      B: { status: 'in_review' },
    },
    blockedBy: ['B'],
    ready: false,
  },
  {
    name: 'transitive dependencies must be merged too',
    items: {
      A: { status: 'approved', deps: ['B'] },
      B: { status: 'merged', deps: ['C'] },
      C: { status: 'dispatched' },
    },
    blockedBy: ['C'],
    ready: false,
  },
  {
    name: 'missing dependencies fail closed',
    items: { A: { status: 'approved', deps: ['B', 'missing'] } },
    blockedBy: ['B', 'missing'],
    ready: false,
  },
  {
    name: 'cycles terminate and include the item itself',
    items: {
      A: { status: 'approved', deps: ['B'] },
      B: { status: 'approved', deps: ['A'] },
    },
    blockedBy: ['B', 'A'],
    ready: false,
  },
  {
    name: 'shared transitive dependencies are listed once',
    items: {
      A: { status: 'approved', deps: ['B', 'C'] },
      B: { status: 'pr_open', deps: ['D'] },
      C: { status: 'merged', deps: ['D'] },
      D: { status: 'merge_queued' },
    },
    blockedBy: ['B', 'D'],
    ready: false,
  },
  {
    name: 'proceed override waives a failed dependency',
    items: { A: { status: 'approved', deps: ['B'] }, B: { status: 'failed' } },
    override: { itemKey: 'A', optionId: 'proceed' },
    blockedBy: [],
    ready: true,
  },
  {
    name: 'proceed override waives a skipped dependency',
    items: { A: { status: 'approved', deps: ['B'] }, B: { status: 'skipped' } },
    override: { itemKey: 'A', optionId: 'proceed' },
    blockedBy: [],
    ready: true,
  },
  {
    name: 'proceed override does not waive an unmerged live dependency',
    items: {
      A: { status: 'approved', deps: ['B', 'C'] },
      B: { status: 'skipped' },
      C: { status: 'pr_open' },
    },
    override: { itemKey: 'A', optionId: 'proceed' },
    blockedBy: ['C'],
    ready: false,
  },
  {
    name: 'proceed override does not waive a missing dependency',
    items: { A: { status: 'approved', deps: ['missing'] } },
    override: { itemKey: 'A', optionId: 'proceed' },
    blockedBy: ['missing'],
    ready: false,
  },
  {
    name: 'another option is not an override',
    items: { A: { status: 'approved', deps: ['B'] }, B: { status: 'failed' } },
    override: { itemKey: 'A', optionId: 'abort' },
    blockedBy: ['B'],
    ready: false,
  },
  {
    name: 'an override for another item does not apply',
    items: {
      A: { status: 'approved', deps: ['B'] },
      B: { status: 'failed' },
      C: { status: 'approved', deps: ['B'] },
    },
    override: { itemKey: 'C', optionId: 'proceed' },
    blockedBy: ['B'],
    ready: false,
  },
  {
    name: 'unknown items are never ready',
    items: { A: { status: 'approved' } },
    key: 'nope',
    blockedBy: [],
    ready: false,
  },
];

function model(row: Row): ReadModel {
  const m = scenario().model;
  m.workItems = Object.entries(row.items).map(([key, item]) => ({
    key,
    title: key,
    body: key,
    acceptance: [],
    role: 'engineer',
    deps: item.deps ?? [],
    status: item.status,
    attempts: 0,
    reworks: 0,
    usage: m.usage.total,
  }));
  // Gates that never decide or do not match the rule must be ignored.
  m.gates = [
    {
      gateId: 'stage',
      workflowId: m.workflowId,
      stageId: 'implement',
      kind: 'stage',
      title: 'Stage',
      status: 'approved',
      version: 1,
      options: [],
      content: { type: 'work-items', artifactId: 'art' },
      openedAt: m.startedAt,
      decision: { decision: 'approve', by: 'user', at: m.startedAt },
    },
    {
      gateId: 'other-kind',
      workflowId: m.workflowId,
      stageId: 'implement',
      kind: 'exception',
      exceptionKind: 'workitem-failed',
      title: 'Failed',
      status: 'approved',
      version: 1,
      options: [],
      content: { type: 'exception', summary: 'x', itemKey: 'A' },
      openedAt: m.startedAt,
      decision: {
        decision: 'option',
        by: 'user',
        at: m.startedAt,
        optionId: 'proceed',
      },
    },
  ];
  if (row.override)
    m.gates.push({
      gateId: 'dep',
      workflowId: m.workflowId,
      stageId: 'implement',
      kind: 'exception',
      exceptionKind: 'dependency-blocked',
      title: 'Blocked',
      status: 'approved',
      version: 1,
      options: [],
      content: {
        type: 'exception',
        summary: 'x',
        itemKey: row.override.itemKey,
      },
      openedAt: m.startedAt,
      decision: {
        decision: 'option',
        by: 'user',
        at: m.startedAt,
        optionId: row.override.optionId,
      },
    });
  return m;
}

describe('G4 readiness helper', () => {
  test.each(rows)('$name', (row) => {
    const m = model(row);
    const key = row.key ?? 'A';
    expect(blockedByOf(m, key)).toEqual(row.blockedBy);
    expect(isReady(m, key)).toBe(row.ready);
  });

  test('does not mutate the read model', () => {
    const m = model(rows[6]!);
    const before = JSON.stringify(m);
    blockedByOf(m, 'A');
    isReady(m, 'A');
    expect(JSON.stringify(m)).toBe(before);
  });
});
