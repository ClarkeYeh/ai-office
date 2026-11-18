import { openSqliteStores } from '../../adapters/store-sqlite/index.js';
import type { EventStore, ProjectionStore } from '../../ports/stores.js';
import { SeqIdGen } from '../../test-support/services.js';
import { describe, expect, it, vi } from 'vitest';
import {
  evolve,
  PROJECTION_VERSION,
  type ReadModel,
} from '@ai-office/projection';
import { GateViewSchema } from '@ai-office/contracts/api';
import {
  DomainEventSchema,
  type DomainEventDraft,
} from '@ai-office/contracts/events';
import {
  InMemoryEventStore,
  InMemoryProjectionStore,
} from '../../test-support/stores.js';
import { FakeClock, ManualScheduler } from '../../test-support/services.js';
import { eventDraft } from '../../test-support/contracts.js';
import type { GateBodyDeps } from './gate-bodies.js';
import { ProjectionService, QueryService } from './index.js';

function start(workflowId = 'wf'): DomainEventDraft {
  const {
    seq: _seq,
    id: _id,
    recordedAt: _at,
    ...draft
  } = DomainEventSchema.parse({
    ...eventDraft(undefined, workflowId),
    seq: 1,
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    recordedAt: '2026-01-01T00:00:00Z',
    type: 'workflow.started',
    payload: {
      templateSnapshot: {
        apiVersion: 'ai-office/v1alpha1',
        id: 'test',
        name: 'Test',
        roles: { lead: { agent: 'codex' } },
        defaults: {
          integrationBranch: 'ai-office/{shortId}',
          maxReruns: 2,
          budget: { hardLimitMultiplier: 2 },
        },
        stages: [
          {
            id: 'meeting',
            kind: 'meeting',
            facilitator: 'lead',
            participants: ['lead'],
            maxRounds: 2,
            timeouts: { roundMin: 1, stageMin: 5 },
            budget: { tokens: 100 },
            conclusion: { requireTechDecisions: false },
            gate: { id: 'review', title: 'Review' },
          },
          {
            id: 'planning',
            kind: 'planning',
            owner: 'lead',
            from: 'meeting',
            timeouts: { stageMin: 5 },
            budget: { tokens: 100 },
            gate: { id: 'plan', title: 'Plan' },
          },
          {
            id: 'implement',
            kind: 'implement',
            role: 'lead',
            from: 'planning',
            maxParallel: 1,
            timeouts: { itemMin: 5 },
            budget: { tokens: 100 },
            onCall: { role: 'lead', questionTimeoutMin: 1 },
            mergeQueue: { role: 'lead', reviewTimeoutMin: 1 },
            escalateOn: [],
          },
          {
            id: 'integrate',
            kind: 'integrate',
            owner: 'lead',
            timeouts: { stageMin: 5 },
            budget: { tokens: 100 },
          },
          {
            id: 'final',
            kind: 'final-pr',
            maxRevisions: 1,
            gate: { id: 'final', title: 'Final' },
          },
        ],
      },
      repo: {
        repoId: 'repo',
        localPath: '/repo',
        orcaRepoId: 'orca',
        github: { owner: 'owner', name: 'repo' },
        defaultBranch: 'main',
        visibility: 'public',
        ownerLogin: 'owner',
        defaultBranchProtected: 'unknown',
      },
      requirement: 'Test read side',
      shortId: 'test',
      integrationBranch: 'ai-office/test',
      roleOverrides: {},
      gateToggles: {},
      budgets: { stages: {}, hardLimitMultiplier: 2 },
      limits: { globalAgents: 2 },
      acknowledgedUnverifiedRuntime: false,
    },
  });
  void _seq;
  void _id;
  void _at;
  return draft;
}
function setup(
  events: EventStore = new InMemoryEventStore(),
  checkpoints: ProjectionStore<ReadModel> = new InMemoryProjectionStore<ReadModel>(),
  gateBodies: GateBodyDeps = {},
) {
  const clock = new FakeClock();
  const scheduler = new ManualScheduler(clock, (timer) =>
    projections.onTimer(timer),
  );
  const projections = new ProjectionService(
    events,
    checkpoints,
    clock,
    scheduler,
  );
  const queries = new QueryService(events, projections, 'fake', gateBodies);
  return { events, checkpoints, clock, scheduler, projections, queries };
}

describe('ProjectionService', () => {
  it('catches up a lagging checkpoint and rebuilds old versions to the same snapshot', () => {
    const events = new InMemoryEventStore();
    const checkpoints = new InMemoryProjectionStore<ReadModel>();
    const [first] = events.append([start()]);
    const initial = evolve(null, first!);
    checkpoints.save('wf', initial!, first!.seq, PROJECTION_VERSION);
    events.append([
      eventDraft(undefined, null),
      { ...eventDraft(), type: 'workflow.paused', payload: { reason: 'auth' } },
    ]);
    const a = setup(events, checkpoints);
    const expected = events
      .read({ workflowId: 'wf' })
      .reduce<ReadModel | null>(evolve, null);
    expect(a.projections.snapshot('wf')).toEqual({
      readModel: expected,
      asOfSeq: 3,
    });
    a.projections.close();
    checkpoints.save(
      'wf',
      { ...initial!, requirement: 'obsolete' },
      1,
      PROJECTION_VERSION - 1,
    );
    const b = setup(events, checkpoints);
    expect(b.projections.snapshot('wf')).toEqual({
      readModel: expected,
      asOfSeq: 3,
    });
    expect(b.projections.snapshot('missing')).toBeNull();
    b.projections.close();
  });

  it('saves every 200 events and after five idle seconds, restarting the idle deadline', () => {
    const s = setup();
    const save = vi.spyOn(s.checkpoints, 'save');
    s.events.append([
      start(),
      ...Array.from({ length: 198 }, () => eventDraft()),
    ]);
    expect(save).not.toHaveBeenCalled();
    s.clock.advance(4000);
    s.scheduler.runDue();
    s.events.append([eventDraft()]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(s.checkpoints.load('wf')?.asOfSeq).toBe(200);
    s.events.append([eventDraft()]);
    s.clock.advance(4000);
    s.scheduler.runDue();
    s.events.append([eventDraft()]);
    s.clock.advance(4999);
    s.scheduler.runDue();
    expect(save).toHaveBeenCalledTimes(1);
    s.clock.advance(1);
    s.scheduler.runDue();
    expect(save).toHaveBeenCalledTimes(2);
    expect(s.checkpoints.load('wf')?.asOfSeq).toBe(202);
    s.projections.close();
  });

  it('keeps queries correct when saving fails, retries, and detaches on close', () => {
    const s = setup();
    const save = vi.spyOn(s.checkpoints, 'save').mockImplementation(() => {
      throw new Error('disk');
    });
    s.events.append([
      start(),
      ...Array.from({ length: 199 }, () => eventDraft()),
    ]);
    expect(s.projections.snapshot('wf')?.asOfSeq).toBe(200);
    s.clock.advance(5000);
    expect(() => s.scheduler.runDue()).not.toThrow();
    save.mockRestore();
    s.events.append([eventDraft()]);
    expect(s.checkpoints.load('wf')?.asOfSeq).toBe(201);
    s.projections.close();
    s.projections.close();
    s.events.append([eventDraft()]);
    expect(s.checkpoints.load('wf')?.asOfSeq).toBe(201);
    expect(() => s.projections.snapshot('wf')).toThrow('closed');
  });

  it('returns owned snapshots that callers cannot mutate', () => {
    const s = setup();
    s.events.append([start()]);
    s.projections.snapshot('wf')!.readModel.requirement = 'changed';
    expect(s.projections.snapshot('wf')!.readModel.requirement).toBe(
      'Test read side',
    );
    s.projections.close();
  });
});

describe('QueryService', () => {
  it('reads global lists, repo and health events, missing entities, and isolated pages', async () => {
    const s = setup();
    const draft = start();
    if (draft.type !== 'workflow.started') throw new Error('fixture');
    s.events.append([
      draft,
      start('other'),
      {
        ...eventDraft(undefined, null),
        type: 'repo.registered',
        payload: draft.payload.repo,
      },
      {
        ...eventDraft(undefined, null),
        type: 'health.changed',
        payload: {
          component: 'runtime',
          status: 'healthy',
          runtimeVerified: true,
        },
      },
      eventDraft(),
      eventDraft(undefined, 'other'),
      eventDraft(),
    ]);
    expect(s.queries.listWorkflows().workflows).toHaveLength(2);
    expect(s.queries.getWorkflow('wf')?.asOfSeq).toBe(7);
    expect(s.queries.listRepos().repos).toHaveLength(1);
    expect(s.queries.getRepo('repo')?.github.name).toBe('repo');
    expect(s.queries.getHealth().runtime).toMatchObject({
      mode: 'fake',
      status: 'healthy',
      verified: true,
    });
    expect(await s.queries.getGate('missing')).toBeNull();
    expect(s.queries.getSeat('missing')).toBeNull();
    expect(s.queries.getRepo('missing')).toBeNull();
    expect(s.queries.listGates()).toEqual({ gates: [] });
    expect(s.queries.listQuestions()).toEqual({ questions: [] });
    expect(s.queries.getEvents('wf', { limit: 2 })).toMatchObject({
      events: [{ seq: 1 }, { seq: 5 }],
      nextAfterSeq: 5,
    });
    expect(s.queries.getEvents('wf', { afterSeq: 5, limit: 2 })).toMatchObject({
      events: [{ seq: 7 }],
    });
    expect(s.queries.getEvents('wf', { afterSeq: 7 })).toEqual({ events: [] });
    expect(() => s.queries.getEvents('wf', { limit: 0 })).toThrow(RangeError);
    expect(() => s.queries.getEvents('wf', { afterSeq: -1 })).toThrow(
      RangeError,
    );
    s.queries.listWorkflows().workflows[0]!.requirement = 'changed';
    expect(s.queries.listWorkflows().workflows[0]!.requirement).toBe(
      'Test read side',
    );
    s.projections.close();
  });
});

it('keeps closed gate details, limits the inbox to open gates, and exposes only escalated questions', async () => {
  const s = setup();
  s.events.append([
    start(),
    {
      ...eventDraft(),
      type: 'seat.spawned',
      payload: {
        seatId: 'wf:lead',
        attemptId: 'attempt',
        attempt: 1,
        stageId: 'meeting',
        role: 'lead',
        agent: 'codex',
        purpose: 'facilitator',
        keepOpen: true,
        spawnCommandId: 'spawn',
      },
    },
    {
      ...eventDraft(),
      type: 'message.question',
      payload: {
        questionId: 'normal',
        attemptId: 'attempt',
        body: 'Normal question',
      },
    },
    {
      ...eventDraft(),
      type: 'message.question',
      payload: {
        questionId: 'escalated',
        attemptId: 'attempt',
        body: 'Needs a decision',
      },
    },
    {
      ...eventDraft(),
      type: 'message.escalated',
      payload: { questionId: 'escalated', reason: 'timeout', gateId: 'gate' },
    },
    {
      ...eventDraft(),
      type: 'gate.opened',
      payload: {
        gateId: 'gate',
        stageId: 'meeting',
        title: 'Decision',
        kind: 'exception',
        exceptionKind: 'question-escalation',
        version: 1,
        options: [],
        content: {
          type: 'exception',
          summary: 'Question',
          questionId: 'escalated',
        },
      },
    },
  ]);
  expect(s.queries.listGates().gates.map((g) => g.gateId)).toEqual(['gate']);
  expect((await s.queries.getGate('gate'))?.version).toBe(1);
  expect(s.queries.listQuestions().questions.map((q) => q.questionId)).toEqual([
    'escalated',
  ]);
  expect(s.queries.getSeat('wf:lead')).toMatchObject({
    currentAttemptId: 'attempt',
    attempts: [{ attemptId: 'attempt' }],
  });
  s.events.append([
    {
      ...eventDraft(),
      type: 'gate.closed',
      payload: { gateId: 'gate', reason: 'superseded' },
    },
  ]);
  expect(s.queries.listGates().gates).toEqual([]);
  expect((await s.queries.getGate('gate'))?.status).toBe('closed');
  s.events.append([
    {
      ...eventDraft(),
      type: 'message.answered',
      payload: { questionId: 'escalated', by: 'user', body: 'Proceed' },
    },
  ]);
  expect(s.queries.listQuestions().questions).toEqual([]);
  s.projections.close();
});

it('recovers a persisted sqlite checkpoint and observes committed batches', () => {
  const stores = openSqliteStores<ReadModel>({
    filename: ':memory:',
    clock: new FakeClock(),
    ids: new SeqIdGen(),
    projectionVersion: PROJECTION_VERSION,
  });
  const a = setup(stores.events, stores.projections);
  try {
    stores.events.append([start(), eventDraft()]);
    a.projections.close();
    expect(stores.projections.load('wf')?.asOfSeq).toBe(2);
    stores.events.append([
      { ...eventDraft(), type: 'workflow.paused', payload: { reason: 'auth' } },
    ]);
    const b = setup(stores.events, stores.projections);
    try {
      expect(b.projections.snapshot('wf')?.readModel.pausedReasons).toContain(
        'auth',
      );
      expect(b.projections.snapshot('wf')?.asOfSeq).toBe(3);
      stores.events.append([eventDraft(), eventDraft()]);
      expect(b.projections.snapshot('wf')?.asOfSeq).toBe(5);
    } finally {
      b.projections.close();
    }
  } finally {
    a.projections.close();
    stores.close();
  }
});

describe('conclusion gate bodies (G3b)', () => {
  const gateId = 'wf/meeting/1/gate';
  const commandId = 'wf/meeting/1/issue';
  const rendered = '## Summary\nShip it';
  const issued = `${rendered}\n\n<!-- ai-office:cmd=${commandId} -->`;
  const repo = { owner: 'owner', name: 'repo' };
  const sha = async (body: string) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)),
      ),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
  const draft = (
    type: DomainEventDraft['type'],
    payload: unknown,
  ): DomainEventDraft =>
    ({ ...eventDraft(), type, payload }) as DomainEventDraft;
  const create = draft('command.issued', {
    commandId,
    kind: 'scm.createIssue',
    args: { repo, title: 'Conclusion', body: issued, labels: [] },
  });
  const created = draft('command.succeeded', {
    commandId,
    kind: 'scm.createIssue',
    result: { issue: 7, url: 'https://github.com/owner/repo/issues/7' },
  });
  const opened = async (renderedHash?: string) =>
    draft('gate.opened', {
      gateId,
      stageId: 'meeting',
      title: 'Review',
      kind: 'stage',
      stageKind: 'meeting',
      templateGateId: 'review',
      optional: false,
      version: 1,
      options: [],
      content: {
        type: 'conclusion',
        artifactId: 'conclusion',
        renderedHash: renderedHash ?? (await sha(issued)),
      },
    });
  const scm = (body: string | Error) => ({
    getIssue: vi.fn(async () => {
      if (body instanceof Error) throw body;
      return { body, bodyHash: await sha(body), updatedAt: '', labels: [] };
    }),
  });
  const logger = () => {
    const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => l };
    return l;
  };

  it('fills the live GitHub body and the marker-free rendered body', async () => {
    const edited = `${issued}\n\nEdited on GitHub.`;
    const port = scm(edited);
    const s = setup(undefined, undefined, { scm: port });
    s.events.append([start(), create, created, await opened()]);
    const gate = await s.queries.getGate(gateId);
    expect(port.getIssue).toHaveBeenCalledWith({ repo, number: 7 });
    expect(gate?.conclusion).toMatchObject({
      renderedBody: rendered,
      githubBody: edited,
    });
    // The UI diffs the two bodies line by line after dropping the marker.
    const strip = (body: string) =>
      body.replace(/\n*<!-- ai-office:cmd=.+? -->/g, '').split('\n');
    const before = new Set(strip(gate!.conclusion!.renderedBody!));
    expect(
      strip(gate!.conclusion!.githubBody!).filter(
        (l) => l !== '' && !before.has(l),
      ),
    ).toEqual(['Edited on GitHub.']);
    expect(GateViewSchema.parse(gate)).toEqual(gate);
    // Bodies are per request, never written back into the read model.
    expect(s.queries.listGates().gates[0]?.conclusion).not.toHaveProperty(
      'renderedBody',
    );
    s.projections.close();
  });

  it('uses the last issue body update and omits a body whose hash does not match', async () => {
    const revised = '## Summary\nRevised';
    const log = logger();
    const s = setup(undefined, undefined, { scm: scm(revised), logger: log });
    s.events.append([
      start(),
      create,
      created,
      draft('command.issued', {
        commandId: 'wf/sync/1',
        kind: 'scm.updateIssue',
        args: { issue: { repo, number: 8 }, patch: { body: 'Other issue' } },
      }),
      draft('command.issued', {
        commandId: 'wf/sync/2',
        kind: 'scm.updateIssue',
        args: { issue: { repo, number: 7 }, patch: { body: revised } },
      }),
      await opened(await sha(revised)),
    ]);
    expect((await s.queries.getGate(gateId))?.conclusion?.renderedBody).toBe(
      revised,
    );
    s.events.append([
      draft('command.issued', {
        commandId: 'wf/sync/3',
        kind: 'scm.updateIssue',
        args: { issue: { repo, number: 7 }, patch: { body: 'Tampered' } },
      }),
    ]);
    const gate = await s.queries.getGate(gateId);
    expect(gate?.conclusion).not.toHaveProperty('renderedBody');
    expect(gate?.conclusion?.githubBody).toBe(revised);
    expect(log.warn).toHaveBeenCalledWith(
      { gateId },
      expect.stringContaining('renderedHash'),
    );
    s.projections.close();
  });

  it('omits githubBody when SCM fails or times out', async () => {
    const log = logger();
    const failing = setup(undefined, undefined, {
      scm: scm(new Error('down')),
      logger: log,
    });
    failing.events.append([start(), create, created, await opened()]);
    const gate = await failing.queries.getGate(gateId);
    expect(gate?.conclusion).not.toHaveProperty('githubBody');
    expect(gate?.conclusion?.renderedBody).toBe(rendered);
    expect(log.warn).toHaveBeenCalledOnce();
    failing.projections.close();

    const slow = setup(undefined, undefined, {
      scm: { getIssue: () => new Promise(() => {}) },
      scmTimeoutMs: 5,
    });
    slow.events.append([start(), create, created, await opened()]);
    expect((await slow.queries.getGate(gateId))?.conclusion).not.toHaveProperty(
      'githubBody',
    );
    slow.projections.close();
  });

  it('leaves legacy gates without bodies parseable and unchanged', async () => {
    const port = scm('unused');
    const s = setup(undefined, undefined, { scm: port });
    // No issue command in the store (e.g. events from before G3b's wiring).
    s.events.append([start(), await opened()]);
    const gate = await s.queries.getGate(gateId);
    expect(gate?.conclusion).not.toHaveProperty('renderedBody');
    expect(gate?.conclusion).not.toHaveProperty('githubBody');
    expect(GateViewSchema.parse(gate)).toEqual(gate);
    expect(port.getIssue).not.toHaveBeenCalled();
    s.projections.close();
  });
});
