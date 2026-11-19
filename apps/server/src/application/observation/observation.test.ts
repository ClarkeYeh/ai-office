import { afterEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_SCHEMA_VERSION } from '@ai-office/contracts/events';
import type {
  DomainEventDraft,
  EventPayload,
  EventType,
} from '@ai-office/contracts/events';
import { external } from '@ai-office/engine';
import { FakeScm } from '../../adapters/scm-fake/index.js';
import { FakeRuntime } from '../../adapters/runtime-fake/index.js';
import { FakeUsage } from '../../adapters/usage-fake/index.js';
import { createRedactorFactory } from '../../adapters/redactor/index.js';
import { openSqliteStores } from '../../adapters/store-sqlite/index.js';
import type { RuntimeEvent } from '../../ports/runtime-events.js';
import {
  AgentRefSchema,
  QuestionRefSchema,
  RuntimeCursorSchema,
  SessionRefSchema,
} from '../../ports/refs.js';
import type { RuntimePort } from '../../ports/runtime.js';
import type { EventStore } from '../../ports/stores.js';
import type { ScheduledTimer } from '../../ports/services.js';
import { FakeClock, SeqIdGen } from '../../test-support/services.js';
import {
  harness,
  startWorkflow,
  START,
  flush,
  lifecycleReact,
  WORKFLOW_ID,
} from '../runner/test-support/harness.js';
import type { RunnerReact } from '../runner/workflow-runner.js';
import {
  ObservationLoop,
  OBSERVATION_TIMER_PREFIX,
  SCM_SLOW_INTERVAL_MS,
} from './index.js';
import { budgetFormula } from './usage.js';

const session = SessionRefSchema.parse('session-1');
const agent = AgentRefSchema.parse('agent-1');
const branch = 'ai-office/worker';
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
});
function draft<T extends EventType>(
  type: T,
  payload: EventPayload<T>,
  scope = {},
): DomainEventDraft {
  return {
    type,
    payload,
    workflowId: WORKFLOW_ID,
    occurredAt: START,
    schemaVersion: CURRENT_SCHEMA_VERSION[type],
    source: 'runtime',
    provenance: 'observed',
    ...scope,
  } as DomainEventDraft;
}
async function setup(
  options: { store?: EventStore; react?: RunnerReact } = {},
) {
  const h = harness(options);
  await h.runners.start(startWorkflow());
  await flush();
  const runner = h.runners.get(WORKFLOW_ID)!;
  await runner.append([
    draft('seat.spawned', {
      attemptId: 'att-1',
      seatId: `${WORKFLOW_ID}/engineer`,
      attempt: 1,
      stageId: 'meeting',
      role: 'engineer',
      agent: 'codex',
      purpose: 'participant',
      keepOpen: true,
      spawnCommandId: 'spawn-1',
    }),
    draft(
      'command.issued',
      {
        commandId: 'spawn-1',
        orcaRequestId: h.ids.orcaRequestId('spawn-1'),
        kind: 'runtime.spawnAgent',
        args: {
          session,
          agent: 'codex',
          title: 'Worker',
          specPath: '/tmp/test-spec.md',
          specSha256: 'a'.repeat(64),
          workspace: {
            kind: 'new-worktree',
            baseBranch: runner.state.workflow!.integrationBranch,
            name: 'worker',
            branch,
          },
          keepOpen: true,
        },
      },
      { attemptId: 'att-1', stageId: 'meeting' },
    ),
    draft('command.succeeded', {
      commandId: 'spawn-1',
      kind: 'runtime.spawnAgent',
      result: { agent },
    }),
  ]);
  const scm = new FakeScm({ clock: h.clock });
  const repo = runner.state.workflow!.repo.github;
  scm.addRepo(repo);
  await scm.ensureBranch(
    repo,
    runner.state.workflow!.integrationBranch,
    'main',
    { workflowId: WORKFLOW_ID, commandId: 'branch' },
  );
  await scm.ensureBranch(repo, branch, 'main', {
    workflowId: WORKFLOW_ID,
    commandId: 'worker',
  });
  scm.pushBranch(repo, branch);
  const usage = new FakeUsage({ clock: h.clock });
  usage.registerAttempt({
    attemptId: 'att-1',
    agent: 'codex',
    reportedSessionId: 'thread-1',
    dispatchId: agent,
  });
  let events: RuntimeEvent[] = [];
  const observe = vi.fn(async () => ({
    events,
    cursor: RuntimeCursorSchema.parse('cursor-1'),
  }));
  const runtime = { observe } as unknown as RuntimePort;
  const timers = new Map<string, ScheduledTimer>();
  const scheduler = {
    schedule: (t: ScheduledTimer) => {
      timers.set(t.id, t);
    },
    cancel: (id: string) => {
      timers.delete(id);
    },
  };
  const redactors = createRedactorFactory();
  const factory = vi.spyOn(redactors, 'forAttempt');
  const deps = {
    runtime,
    scm,
    usage,
    store: h.store,
    redactors,
    clock: h.clock,
    scheduler,
    logger: h.logger,
    workflows: () => h.runners.all(),
  };
  const loop = new ObservationLoop(deps);
  cleanups.push(() => loop.stop());
  return {
    ...h,
    runner,
    scm,
    repo,
    usage,
    loop,
    deps,
    observe,
    factory,
    timers,
    setEvents: (value: RuntimeEvent[]) => {
      events = value;
    },
  };
}
const output = (
  key = 'output-1',
  command = 'git push',
): Extract<RuntimeEvent, { type: 'agent.output' }> => ({
  type: 'agent.output',
  agent,
  externalKey: key,
  occurredAt: START,
  role: 'assistant',
  messageId: 'msg-1',
  blocks: [
    { type: 'tool_use', id: 'tool-1', name: 'shell', input: { command } },
    {
      type: 'text',
      text: 'Private user@example.com text must never be stored',
    },
  ],
});
const usageEvents = (h: Awaited<ReturnType<typeof setup>>) =>
  h.events().filter((e) => e.type === 'usage.tokens');

describe('runtime ingestion', () => {
  it('deduplicates batches, redacts output, counts assistant messages once and uses the worker branch', async () => {
    const h = await setup();
    h.setEvents([
      output(),
      output(),
      { ...output('output-2'), blocks: [] } as RuntimeEvent,
    ]);
    await h.loop.pollRuntime(h.runner, session);
    const seq = h.store.lastSeq();
    await h.loop.pollRuntime(h.runner, session);
    expect(h.store.lastSeq()).toBe(seq);
    expect(h.runner.state.usage.attempts['att-1']?.turns).toBe(1);
    expect(h.events().filter((e) => e.type === 'seat.activity')).toHaveLength(
      1,
    );
    expect(h.events().some((e) => e.type === 'seat.policy_violation')).toBe(
      false,
    );
    expect(h.factory).toHaveBeenCalledWith(
      expect.objectContaining({ currentBranch: branch, attemptId: 'att-1' }),
    );
    expect(JSON.stringify(h.events())).not.toContain('user@example.com');
    expect(h.observe).toHaveBeenLastCalledWith(session, 'cursor-1');
  });
  it('routes high policy hits through runner react to the stop outbox', async () => {
    // T16 owns the production exception policy (still a stub on this base).
    const h = await setup({
      react: (state, event) => [
        ...lifecycleReact(state, event),
        ...(event.type === 'seat.policy_violation' &&
        event.payload.hits.some((hit) => hit.severity === 'high')
          ? [
              external(
                'policy-stop',
                { kind: 'runtime.stop', args: { agent } },
                { attemptId: 'att-1' },
              ),
            ]
          : []),
      ],
    });
    h.setEvents([output('policy-output', 'git push origin main')]);
    await h.loop.pollRuntime(h.runner, session);
    await flush();
    expect(h.world.callsOf('stop')).toEqual([[agent]]);
    expect(
      h.events().filter((e) => e.type === 'seat.policy_violation'),
    ).toHaveLength(1);
    expect(h.runner.state.workflow!.pausedReasons).toContain('anomaly');
  });
  it('records masked questions, degraded status and successful completion', async () => {
    const h = await setup();
    h.setEvents([
      {
        type: 'agent.status',
        agent,
        externalKey: 'working',
        occurredAt: START,
        state: 'working',
      },
      {
        type: 'agent.question',
        agent,
        externalKey: 'question-1',
        occurredAt: START,
        question: QuestionRefSchema.parse('q-1'),
        body: 'Contact user@example.com?',
      },
      {
        type: 'agent.degraded',
        agent,
        externalKey: 'degraded',
        occurredAt: START,
        reason: 'source_changed',
      },
      {
        type: 'agent.done',
        agent,
        externalKey: 'done',
        occurredAt: START,
        outcome: 'success',
      },
    ]);
    await h.loop.pollRuntime(h.runner, session);
    expect(h.runner.state.questions['q-1']?.body).not.toContain(
      'user@example.com',
    );
    expect(h.runner.state.attempts['att-1']).toMatchObject({
      state: 'done',
      degraded: true,
    });
  });
  it('maps provider rate-limit evidence to seat.status rateLimited, keeping the first since (S26)', async () => {
    const h = await setup();
    const later = new Date(Date.parse(START) + 60_000).toISOString();
    const resetsAt = new Date(Date.parse(START) + 3_600_000).toISOString();
    h.setEvents([
      {
        type: 'agent.status',
        agent,
        externalKey: 'waiting',
        occurredAt: START,
        state: 'waiting_input',
        waitingSince: START,
      },
      {
        type: 'agent.rate_limited',
        agent,
        externalKey: 'limit-1',
        occurredAt: START,
        evidence: 'worker-show',
      },
      {
        type: 'agent.rate_limited',
        agent,
        externalKey: 'limit-2',
        occurredAt: later,
        evidence: 'transcript',
        resetsAt,
      },
    ]);
    await h.loop.pollRuntime(h.runner, session);
    const statuses = h
      .events()
      .filter((e) => e.type === 'seat.status')
      .map((e) => e.payload);
    expect(statuses.slice(1)).toEqual([
      {
        attemptId: 'att-1',
        state: 'waiting_input',
        waitingSince: START,
        rateLimited: { since: START, evidence: 'worker-show' },
      },
      {
        attemptId: 'att-1',
        state: 'waiting_input',
        waitingSince: START,
        rateLimited: { since: START, evidence: 'transcript', resetsAt },
      },
    ]);
    expect(h.runner.state.attempts['att-1']).toMatchObject({
      state: 'waiting_input',
      waitingSince: START,
      rateLimited: { since: START, lastEvidenceAt: later, resetsAt },
    });
    expect(h.events().some((e) => e.type === 'error.recorded')).toBe(false);
    // Redelivery is idempotent by externalKey.
    await h.loop.pollRuntime(h.runner, session);
    expect(h.events().filter((e) => e.type === 'seat.status')).toHaveLength(3);
  });
  it.each([false, true])(
    'marks a stopped attempt expected only with a backend command: %s',
    async (commanded) => {
      const h = await setup();
      if (commanded)
        await h.runner.append([
          draft('command.issued', {
            commandId: 'stop-1',
            kind: 'runtime.stop',
            args: { agent },
          }),
        ]);
      h.setEvents([
        {
          type: 'agent.stopped',
          agent,
          externalKey: 'stop',
          occurredAt: START,
        },
      ]);
      await h.loop.pollRuntime(h.runner, session);
      expect(h.runner.state.attempts['att-1']?.exit?.expected).toBe(commanded);
      expect(h.runner.state.workflow!.pausedReasons.includes('anomaly')).toBe(
        !commanded,
      );
    },
  );
  it('detects unmanaged agents and does not silently consume unknown agent observations', async () => {
    const h = await setup();
    h.setEvents([
      {
        type: 'agent.unmanaged',
        dispatch: 'foreign',
        externalKey: 'foreign',
        occurredAt: START,
      },
    ]);
    await h.loop.pollRuntime(h.runner, session);
    expect(h.runner.state.unmanagedAgents).toHaveLength(1);
    h.setEvents([{ ...output(), agent: AgentRefSchema.parse('unknown') }]);
    await expect(h.loop.pollRuntime(h.runner, session)).rejects.toThrow(
      'no recorded attempt',
    );
  });
});

it('keeps adapter-filtered finished and turn-start-unobserved escalations out of domain failures', async () => {
  const h = await setup();
  const runtime = new FakeRuntime({ clock: h.clock });
  const fakeSession = await runtime.openSession({
    workflowId: WORKFLOW_ID,
    repo: { orcaRepoId: 'repo', localPath: '/repo' },
    objective: 'Test',
    correlation: { workflowId: WORKFLOW_ID, commandId: 'open' },
  });
  const fakeAgent = await runtime.spawnAgent({
    session: fakeSession,
    agent: 'codex',
    title: 'Worker',
    prompt: 'Test',
    workspace: {
      kind: 'new-worktree',
      baseBranch: 'main',
      name: 'worker',
      branch,
    },
    keepOpen: true,
    correlation: { workflowId: WORKFLOW_ID, commandId: 'spawn' },
  });
  runtime.enqueue(
    fakeAgent,
    { type: 'ask', body: 'Question?' },
    { type: 'false-escalation' },
    { type: 'turn-start-unobserved' },
  );
  await runtime.runDue();
  const result = await runtime.observe(fakeSession, null);
  h.setEvents(
    result.events.map((event) =>
      'agent' in event ? { ...event, agent } : event,
    ),
  );
  await h.loop.pollRuntime(h.runner, session);
  expect(Object.values(h.runner.state.questions)).toHaveLength(1);
  expect(h.runner.state.attempts['att-1']?.state).not.toBe('error');
  expect(h.runner.state.anomalies).toHaveLength(0);
});

describe('usage ingestion', () => {
  it('prefers the matching provider session recorded on the attempt over fallback hints', async () => {
    const h = await setup();
    Object.assign(h.runner.state.attempts['att-1']!, {
      agentSession: { provider: 'codex', id: 'thread-1' },
    });
    const locate = vi.spyOn(h.usage, 'locate');
    const loop = new ObservationLoop({
      ...h.deps,
      usageIdentity: () => ({ reportedSessionId: 'stale-hint' }),
    });
    await loop.pollUsage(h.runner, 'att-1', {
      reportedSessionId: 'another-hint',
    });
    expect(locate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reportedSessionId: 'thread-1',
        dispatchId: agent,
      }),
    );
  });
  it.each([undefined, { provider: 'claude', id: 'wrong-provider' }])(
    'falls back to dispatch search without a matching attempt session: %j',
    async (agentSession) => {
      const h = await setup();
      if (agentSession)
        Object.assign(h.runner.state.attempts['att-1']!, { agentSession });
      const locate = vi.spyOn(h.usage, 'locate');
      await h.loop.pollUsage(h.runner, 'att-1');
      expect(locate).toHaveBeenLastCalledWith({
        attemptId: 'att-1',
        agent: 'codex',
        dispatchId: agent,
      });
    },
  );
  it('persists cumulative baselines with cursors and resumes with correct deltas and distinct keys', async () => {
    const h = await setup();
    h.usage.append('att-1', {
      inputUncached: 100,
      output: 20,
      cacheRead: 500,
      cacheWrite: 0,
      reasoning: 5,
    });
    await h.loop.pollUsage(h.runner, 'att-1');
    h.usage.append('att-1', {
      inputUncached: 160,
      output: 40,
      cacheRead: 700,
      cacheWrite: 0,
      reasoning: 9,
    });
    const restarted = new ObservationLoop(h.deps);
    await restarted.pollUsage(h.runner, 'att-1');
    await restarted.pollUsage(h.runner, 'att-1');
    expect(usageEvents(h).map((e) => e.payload)).toEqual([
      {
        attemptId: 'att-1',
        inputUncached: 100,
        output: 20,
        cacheRead: 500,
        cacheWrite: 0,
        reasoning: 5,
        budgetTokens: 120,
      },
      {
        attemptId: 'att-1',
        inputUncached: 60,
        output: 20,
        cacheRead: 200,
        cacheWrite: 0,
        reasoning: 4,
        budgetTokens: 80,
      },
    ]);
    expect(usageEvents(h).map((e) => e.externalKey)).toEqual([
      'usage:codex:thread-1:620',
      'usage:codex:thread-1:900',
    ]);
    expect(h.runner.state.usage.workflow.tokens).toBe(200);
  });
  it('uses reported session identity and rejects regression without advancing', async () => {
    const h = await setup();
    const locate = vi.spyOn(h.usage, 'locate');
    h.usage.append('att-1', {
      inputUncached: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
    });
    await h.loop.pollUsage(h.runner, 'att-1', {
      reportedSessionId: 'thread-1',
    });
    expect(locate).toHaveBeenCalledWith(
      expect.objectContaining({ reportedSessionId: 'thread-1' }),
    );
    h.usage.append('att-1', {
      inputUncached: 50,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
    });
    await expect(h.loop.pollUsage(h.runner, 'att-1')).rejects.toThrow(
      'regressed',
    );
    expect(usageEvents(h)).toHaveLength(1);
  });
  it('deduplicates Claude message ids and supports weighted cache budgets', async () => {
    const h = await setup();
    const read = vi.spyOn(h.usage, 'read');
    const sample = {
      externalKey: 'usage:claude:message-1',
      occurredAt: START,
      cumulative: false,
      inputUncached: 10,
      output: 4,
      cacheRead: 100,
      cacheWrite: 2,
    };
    read.mockResolvedValue({ samples: [sample, sample], cursor: '' as never });
    const loop = new ObservationLoop({
      ...h.deps,
      budgetFormula: 'inputUncached + output + cacheWrite + cacheRead * 0.1',
    });
    await loop.pollUsage(h.runner, 'att-1');
    await loop.pollUsage(h.runner, 'att-1');
    expect(usageEvents(h)).toHaveLength(1);
    expect(usageEvents(h)[0]!.payload.budgetTokens).toBe(26);
    expect(() => budgetFormula('process.exit()')).toThrow('Invalid');
  });
});

async function conclusion(h: Awaited<ReturnType<typeof setup>>) {
  const issue = await h.scm.createIssue(
    h.repo,
    { title: 'Conclusion', body: 'Original', labels: [] },
    { workflowId: WORKFLOW_ID, commandId: 'conclusion' },
  );
  const initial = await h.scm.getIssue(issue);
  await h.runner.append([
    draft(
      'artifact.created',
      {
        artifactId: 'conclusion-issue',
        kind: 'issue',
        purpose: 'conclusion',
        number: issue.number,
        url: issue.url,
      },
      { stageId: 'meeting' },
    ),
    draft('gate.opened', {
      gateId: 'conclusion-gate',
      stageId: 'meeting',
      kind: 'stage',
      stageKind: 'meeting',
      templateGateId: 'conclusion',
      optional: false,
      title: 'Conclusion',
      options: [],
      version: 1,
      content: {
        type: 'conclusion',
        artifactId: 'conclusion-body',
        renderedHash: initial.bodyHash,
      },
    }),
  ]);
  return { issue, initial };
}
describe('SCM ingestion', () => {
  it('records each default-head transition from branch.head_changed, without compareBranch per poll', async () => {
    const h = await setup();
    const compare = vi.spyOn(h.scm, 'compareBranch');
    await h.loop.pollScm(h.runner);
    for (let i = 0; i < 3; i++) {
      h.scm.pushBranch(h.repo, 'main');
      await h.loop.pollScm(h.runner);
    }
    await h.loop.pollScm(h.runner);
    expect(
      h.runner.state.anomalies.filter((a) => a.kind === 'default-branch-moved'),
    ).toHaveLength(3);
    expect(compare).not.toHaveBeenCalled();
    expect(h.store.readCursor('observation.scm', WORKFLOW_ID)).toEqual({
      v: 2,
      cursor: expect.any(String),
    });
  });
  it('takes the first poll as the baseline even when the list replays older head moves', async () => {
    const h = await setup();
    h.scm.pushBranch(h.repo, 'main');
    h.scm.pushBranch(h.repo, 'main');
    await h.loop.pollScm(h.runner);
    expect(h.runner.state.anomalies).toEqual([]);
    h.scm.pushBranch(h.repo, 'main');
    await h.loop.pollScm(h.runner);
    expect(
      h.runner.state.anomalies.filter((a) => a.kind === 'default-branch-moved'),
    ).toHaveLength(1);
  });
  it('migrates a v1 checkpoint with one default-head comparison, then drops it', async () => {
    const h = await setup();
    await h.loop.pollScm(h.runner);
    const v2 = h.store.readCursor('observation.scm', WORKFLOW_ID) as {
      cursor: string;
    };
    const before = await h.scm.compareBranch(h.repo, 'main', 'main');
    // A pre-M3 backend recorded the default head; it moved while stopped.
    await h.runner.append(
      [],
      [
        {
          source: 'observation.scm',
          scope: WORKFLOW_ID,
          value: { cursor: v2.cursor, defaultSha: before!.headSha, poll: 4 },
        },
      ],
    );
    h.scm.pushBranch(h.repo, 'main');
    const compare = vi.spyOn(h.scm, 'compareBranch');
    await h.loop.pollScm(h.runner);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(
      h.runner.state.anomalies.filter((a) => a.kind === 'default-branch-moved'),
    ).toHaveLength(1);
    await h.loop.pollScm(h.runner);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(h.store.readCursor('observation.scm', WORKFLOW_ID)).toEqual({
      v: 2,
      cursor: expect.any(String),
    });
  });
  it('treats a head_changed with previousSha null as a baseline, never a move (T6 rule a)', async () => {
    const h = await setup();
    const sha = (c: string) => c.repeat(40);
    const poll = vi.spyOn(h.scm, 'poll');
    for (const [i, branchName] of [
      h.runner.state.workflow!.repo.defaultBranch,
      h.runner.state.workflow!.integrationBranch,
    ].entries())
      poll.mockResolvedValueOnce({
        events: [
          {
            type: 'branch.head_changed',
            externalKey: `baseline-${i}`,
            occurredAt: START,
            branch: branchName,
            sha: sha('d'),
            previousSha: null,
          },
        ],
        cursor: (await h.scm.poll(h.repo, null)).cursor,
      });
    await h.loop.pollScm(h.runner);
    await h.loop.pollScm(h.runner);
    expect(h.runner.state.anomalies).toEqual([]);
    expect(h.runner.state.workflow!.pausedReasons.includes('anomaly')).toBe(
      false,
    );
  });
  describe('duplicates and integration-branch moves (M3-T9 part 3)', () => {
    const sha = (c: string) => c.repeat(40);
    type Poll = Awaited<ReturnType<FakeScm['poll']>>;
    const listing = async (
      h: Awaited<ReturnType<typeof setup>>,
      events: Poll['events'],
    ) => {
      // The real first poll is the baseline; then serve `events` once.
      await h.loop.pollScm(h.runner);
      vi.spyOn(h.scm, 'poll').mockResolvedValueOnce({
        events,
        cursor: (await h.scm.poll(h.repo, null)).cursor,
      });
    };
    const implementing = (h: Awaited<ReturnType<typeof setup>>) =>
      h.runner.append([
        draft('stage.started', {
          stageId: 'implement',
          kind: 'implement',
          attempt: 1,
          mode: 'initial',
        }),
      ]);
    const move = (
      h: Awaited<ReturnType<typeof setup>>,
      key: string,
      to: string,
    ): Poll['events'][number] => ({
      type: 'branch.head_changed',
      externalKey: key,
      occurredAt: START,
      branch: h.runner.state.workflow!.integrationBranch,
      sha: sha(to),
      previousSha: sha('d'),
    });
    const mergeIssued = (h: Awaited<ReturnType<typeof setup>>) =>
      h.runner.append([
        draft('command.issued', {
          commandId: 'merge-1',
          kind: 'scm.mergePR',
          args: {
            pr: { repo: h.repo, number: 9 },
            method: 'merge',
            expectedHeadSha: sha('a'),
          },
        }),
      ]);
    const moved = (h: Awaited<ReturnType<typeof setup>>) =>
      h.runner.state.anomalies.filter(
        (a) => a.kind === 'integration-branch-moved',
      );
    const deferred = (h: Awaited<ReturnType<typeof setup>>) =>
      (
        h.store.readCursor('observation.scm', WORKFLOW_ID) as {
          deferred?: unknown[];
        }
      ).deferred;

    it("compensates only this workflow's duplicates and never pauses (T6 rule b)", async () => {
      const h = await setup();
      await h.runner.append([
        draft('command.issued', {
          commandId: 'issue-1',
          kind: 'scm.createIssue',
          args: { repo: h.repo, title: 't', body: 'b', labels: [] },
        }),
        draft('command.succeeded', {
          commandId: 'issue-1',
          kind: 'scm.createIssue',
          result: { issue: 4, url: 'https://github.com/o/r/issues/4' },
        }),
      ]);
      await listing(h, [
        {
          type: 'object.duplicate',
          externalKey: 'dup-own',
          occurredAt: START,
          commandId: 'issue-1',
          kind: 'issue',
          numbers: [3, 4],
        },
        {
          type: 'object.duplicate',
          externalKey: 'dup-foreign',
          occurredAt: START,
          commandId: 'other-run-cmd',
          kind: 'comment',
          target: { repo: h.repo, number: 3 },
          commentIds: ['c1', 'c2'],
        },
      ]);
      await h.loop.pollScm(h.runner);
      expect(
        h.runner.state.anomalies.map((a) => [a.kind, a.number, a.commandId]),
      ).toEqual([['duplicate-object', 3, 'issue-1']]);
      expect(h.runner.state.workflow!.pausedReasons).toEqual([]);
      expect(JSON.stringify(h.events())).not.toContain('other-run-cmd');
    });

    it('raises integration-branch-moved for a move outside a backend merge during implement', async () => {
      const h = await setup();
      await implementing(h);
      await listing(h, [move(h, 'm1', 'e')]);
      await h.loop.pollScm(h.runner);
      expect(moved(h)).toMatchObject([
        {
          kind: 'integration-branch-moved',
          severity: 'warning',
          sha: sha('e'),
        },
      ]);
      expect(deferred(h)).toBeUndefined();
    });

    it('holds a move back while a merge is in flight; its own merge commit stays quiet', async () => {
      const h = await setup();
      await implementing(h);
      await mergeIssued(h);
      await listing(h, [move(h, 'm1', 'f')]);
      await h.loop.pollScm(h.runner);
      expect(moved(h)).toEqual([]);
      expect(deferred(h)).toHaveLength(1);
      await h.runner.append([
        draft('command.succeeded', {
          commandId: 'merge-1',
          kind: 'scm.mergePR',
          result: { mergeCommitSha: sha('f') },
        }),
      ]);
      await h.loop.pollScm(h.runner);
      expect(moved(h)).toEqual([]);
      expect(deferred(h)).toBeUndefined();
    });

    it('judges a held-back move once the merge fails, even when critical pace skips the poll', async () => {
      const h = await setup();
      await implementing(h);
      await mergeIssued(h);
      let pace: 'normal' | 'critical' = 'normal';
      const loop = new ObservationLoop({ ...h.deps, scmPace: () => pace });
      await loop.pollScm(h.runner);
      vi.spyOn(h.scm, 'poll').mockResolvedValueOnce({
        events: [move(h, 'm1', 'e')],
        cursor: (await h.scm.poll(h.repo, null)).cursor,
      });
      await loop.pollScm(h.runner);
      expect(deferred(h)).toHaveLength(1);
      await h.runner.append([
        draft('command.failed', {
          commandId: 'merge-1',
          kind: 'scm.mergePR',
          attempts: 1,
          error: {
            category: 'conflict',
            code: 'not_mergeable',
            message: 'x',
            retryable: false,
          },
        }),
      ]);
      pace = 'critical';
      const poll = vi.spyOn(h.scm, 'poll');
      poll.mockClear();
      await loop.pollScm(h.runner);
      expect(poll).not.toHaveBeenCalled();
      expect(moved(h)).toMatchObject([{ sha: sha('e') }]);
      expect(deferred(h)).toBeUndefined();
    });
  });
  it('ignores head moves of the integration and worker branches here', async () => {
    const h = await setup();
    await h.loop.pollScm(h.runner);
    h.scm.pushBranch(h.repo, branch);
    await h.loop.pollScm(h.runner);
    expect(h.runner.state.anomalies).toEqual([]);
  });
  it('bumps conclusion version on body change only, and reports drift after approval', async () => {
    const h = await setup();
    const { issue } = await conclusion(h);
    await h.loop.pollScm(h.runner);
    expect(h.runner.state.gates['conclusion-gate']?.version).toBe(1);
    await h.scm.setLabels(issue, ['new-label']);
    await h.loop.pollScm(h.runner);
    expect(h.runner.state.gates['conclusion-gate']?.version).toBe(1);
    await h.scm.editIssueBody(issue, 'Edited');
    await h.loop.pollScm(h.runner);
    expect(h.runner.state.gates['conclusion-gate']?.version).toBe(2);
    await h.loop.pollScm(h.runner);
    expect(h.runner.state.gates['conclusion-gate']?.version).toBe(2);
    await h.runner.append([
      draft('gate.decided', {
        gateId: 'conclusion-gate',
        decision: 'approve',
        by: 'user',
        version: 2,
      }),
    ]);
    await h.scm.editIssueBody(issue, 'After approval');
    await h.loop.pollScm(h.runner);
    expect(h.events().filter((e) => e.type === 'scm.issue_drift')).toHaveLength(
      1,
    );
  });
  it.each([false, true])(
    'compares worker merges to the backend command ledger: managed=%s',
    async (managed) => {
      const h = await setup();
      const pr = await h.scm.openPR(
        h.repo,
        {
          title: 'Worker PR',
          body: '',
          head: branch,
          base: h.runner.state.workflow!.integrationBranch,
        },
        { workflowId: WORKFLOW_ID, commandId: 'worker-pr' },
      );
      const head = await h.scm.compareBranch(h.repo, 'main', branch);
      if (managed)
        await h.runner.append([
          draft('command.issued', {
            commandId: 'merge',
            kind: 'scm.mergePR',
            args: {
              pr: { repo: h.repo, number: pr.number },
              method: 'merge',
              expectedHeadSha: head!.headSha,
            },
          }),
        ]);
      await h.scm.mergeExternally(pr);
      await h.loop.pollScm(h.runner);
      expect(
        h.runner.state.anomalies.some((a) => a.kind === 'unmanaged-merge'),
      ).toBe(!managed);
      expect(h.runner.state.prs[pr.number]?.state).toBe('merged');
      // Polling confirms merge state; workitem.merged belongs to command success.
      expect(h.events().some((e) => e.type === 'workitem.merged')).toBe(false);
    },
  );
  it('persists default head across restart and exempts only the real final merge SHA', async () => {
    const h = await setup();
    await h.loop.pollScm(h.runner);
    const pr = await h.scm.openPR(
      h.repo,
      { title: 'Final PR', body: '', head: branch, base: 'main' },
      { workflowId: WORKFLOW_ID, commandId: 'final' },
    );
    await h.runner.append([
      draft('artifact.created', {
        artifactId: 'final',
        kind: 'pr',
        purpose: 'final',
        number: pr.number,
        url: pr.url,
        head: branch,
        base: 'main',
      }),
    ]);
    const merge = await h.scm.mergeExternally(pr);
    await new ObservationLoop(h.deps).pollScm(h.runner);
    expect(h.runner.state.prs[pr.number]?.mergeCommitSha).toBe(
      merge.mergeCommitSha,
    );
    expect(
      h.runner.state.anomalies.some((a) => a.kind === 'default-branch-moved'),
    ).toBe(false);
    h.scm.pushBranch(h.repo, 'main');
    await new ObservationLoop(h.deps).pollScm(h.runner);
    expect(
      h.runner.state.anomalies.filter((a) => a.kind === 'default-branch-moved'),
    ).toHaveLength(1);
  });
  it('passes creation time when detecting unmarked owner objects', async () => {
    const h = await setup();
    await h.scm.createExternalIssue(h.repo, {
      title: 'Manual',
      body: '',
      labels: [],
    });
    await h.loop.pollScm(h.runner);
    expect(
      h.runner.state.anomalies.some((a) => a.kind === 'unknown-object'),
    ).toBe(true);
  });
});

describe('transactions and lifecycle', () => {
  it('rolls back real SQLite events when cursor insert fails, then replays successfully', async () => {
    const sqlite = openSqliteStores({
      filename: ':memory:',
      clock: new FakeClock(START),
      ids: new SeqIdGen(),
      projectionVersion: 1,
    });
    cleanups.push(() => sqlite.close());
    const store = sqlite.events;
    const h = await setup({ store });
    const seq = store.lastSeq();
    const append = store.append.bind(store);
    // JSON conversion happens inside SQLite's transaction, after event INSERTs.
    vi.spyOn(store, 'append').mockImplementationOnce((drafts, opts) =>
      append(drafts, {
        cursors: opts!.cursors!.map((cursor) => ({ ...cursor, value: 1n })),
      }),
    );
    h.setEvents([output()]);
    await expect(h.loop.pollRuntime(h.runner, session)).rejects.toThrow();
    expect(store.lastSeq()).toBe(seq);
    expect(
      store.readCursor(
        'observation.runtime',
        JSON.stringify([WORKFLOW_ID, session]),
      ),
    ).toBeNull();
    await h.loop.pollRuntime(h.runner, session);
    expect(store.lastSeq()).toBeGreaterThan(seq);
    expect(
      store.readCursor(
        'observation.runtime',
        JSON.stringify([WORKFLOW_ID, session]),
      ),
    ).toBe('cursor-1');
  });
  it('serializes overlapping reads of one source and retries a failed source without wedging', async () => {
    const h = await setup();
    h.setEvents([output()]);
    await Promise.all([
      h.loop.pollRuntime(h.runner, session),
      h.loop.pollRuntime(h.runner, session),
    ]);
    expect(h.observe.mock.calls).toEqual([
      [session, null],
      [session, 'cursor-1'],
    ]);
    h.observe.mockRejectedValueOnce(new Error('read failed'));
    await expect(h.loop.pollRuntime(h.runner, session)).rejects.toThrow(
      'read failed',
    );
    await h.loop.pollRuntime(h.runner, session);
    expect(h.events().filter((e) => e.type === 'usage.turns')).toHaveLength(1);
  });
  it('does not block SCM behind a long runtime poll', async () => {
    const h = await setup();
    let resolve!: (value: Awaited<ReturnType<RuntimePort['observe']>>) => void;
    h.observe.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = h.loop.pollRuntime(h.runner, session);
    await h.loop.pollScm(h.runner);
    expect(h.store.readCursor('observation.scm', WORKFLOW_ID)).not.toBeNull();
    resolve({ events: [], cursor: RuntimeCursorSchema.parse('next') });
    await pending;
  });
  it('schedules one runtime loop per session, continues paused, slows final-PR polls, and stops on completion', async () => {
    const h = await setup();
    h.loop.start();
    h.loop.start();
    expect(
      [...h.timers.keys()].filter((k) =>
        k.startsWith(OBSERVATION_TIMER_PREFIX),
      ),
    ).toHaveLength(3);
    expect(h.loop.scmInterval(h.runner)).toBe(15000);
    await h.runner.append([draft('workflow.paused', { reason: 'anomaly' })]);
    const timer = [...h.timers.values()].find((t) => t.id.includes('runtime'))!;
    h.timers.delete(timer.id);
    await Promise.all([h.loop.onTimer(timer), h.loop.onTimer(timer)]);
    expect(h.observe).toHaveBeenCalledTimes(1);
    expect(h.timers.size).toBe(3);
    await h.runner.append([
      draft('gate.opened', {
        gateId: 'final-gate',
        stageId: 'final-pr',
        kind: 'stage',
        stageKind: 'final-pr',
        templateGateId: 'final-pr',
        optional: false,
        title: 'Final',
        options: [],
        version: 1,
        content: { type: 'final-pr', artifactId: 'final-pr', pr: 1 },
      }),
    ]);
    expect(h.loop.scmInterval(h.runner)).toBe(30000);
    expect(
      new ObservationLoop({ ...h.deps, scmIntervalMs: 250 }).scmInterval(
        h.runner,
      ),
    ).toBe(250);
    expect(() => new ObservationLoop({ ...h.deps, scmIntervalMs: 0 })).toThrow(
      'Invalid observation interval',
    );
    await h.runner.append([draft('workflow.cancelled', { reason: 'user' })]);
    await flush();
    expect(h.timers.size).toBe(0);
    h.loop.stop();
  });
  it('slows SCM polls at a low rate limit and polls only the final PR or a merge in flight when critical (§12.2)', async () => {
    const h = await setup();
    let pace: 'normal' | 'slow' | 'critical' = 'normal';
    const loop = new ObservationLoop({ ...h.deps, scmPace: () => pace });
    const poll = vi.spyOn(h.scm, 'poll');
    expect(loop.scmInterval(h.runner)).toBe(15_000);
    pace = 'slow';
    expect(loop.scmInterval(h.runner)).toBe(SCM_SLOW_INTERVAL_MS);
    pace = 'critical';
    expect(loop.scmInterval(h.runner)).toBe(SCM_SLOW_INTERVAL_MS);
    await loop.pollScm(h.runner);
    expect(poll).not.toHaveBeenCalled();
    await h.runner.append([
      draft('command.issued', {
        commandId: 'merge',
        kind: 'scm.mergePR',
        args: {
          pr: { repo: h.repo, number: 1 },
          method: 'merge',
          expectedHeadSha: 'a'.repeat(40),
        },
      }),
    ]);
    await loop.pollScm(h.runner);
    expect(poll).toHaveBeenCalledTimes(1);
    await h.runner.append([
      draft('command.failed', {
        commandId: 'merge',
        kind: 'scm.mergePR',
        attempts: 1,
        error: {
          category: 'permanent',
          code: 'x',
          message: 'x',
          retryable: false,
        },
      }),
      draft('gate.opened', {
        gateId: 'final-gate',
        stageId: 'final-pr',
        kind: 'stage',
        stageKind: 'final-pr',
        templateGateId: 'final-pr',
        optional: false,
        title: 'Final',
        options: [],
        version: 1,
        content: { type: 'final-pr', artifactId: 'final-pr', pr: 1 },
      }),
    ]);
    await loop.pollScm(h.runner);
    expect(poll).toHaveBeenCalledTimes(2);
    pace = 'slow';
    expect(loop.scmInterval(h.runner)).toBe(SCM_SLOW_INTERVAL_MS);
    pace = 'normal';
    expect(loop.scmInterval(h.runner)).toBe(30_000);
  });
});
