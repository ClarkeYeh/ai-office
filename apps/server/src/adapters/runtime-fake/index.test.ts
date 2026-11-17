import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../test-support/services.js';
import { runtimePortContract } from '../../test-support/runtime-port-contract.js';
import { FakeRuntime } from './index.js';
import type { FakeRuntimeOptions } from './index.js';
import type { SpawnRequest } from './scenario.js';
import { RuntimeEventSchema } from '../../ports/runtime-events.js';

async function fixture(options: Partial<FakeRuntimeOptions> = {}) {
  const clock = new FakeClock();
  const runtime = new FakeRuntime({ clock, ...options });
  const repo = { orcaRepoId: 'repo', localPath: '/repo' };
  const session = await runtime.openSession({
    workflowId: 'wf',
    repo,
    objective: 'test',
    correlation: { workflowId: 'wf', commandId: 'open' },
  });
  const spawnRequest: SpawnRequest = {
    session,
    agent: 'codex',
    title: 'worker',
    prompt: 'Seat token: aio_seat_test',
    workspace: {
      kind: 'new-worktree',
      baseBranch: 'integration',
      name: 'worker',
      branch: 'work',
    },
    correlation: { workflowId: 'wf', attemptId: 'attempt', commandId: 'spawn' },
    keepOpen: true,
  };
  return { clock, runtime, session, spawnRequest, repo };
}
runtimePortContract(async () => {
  const f = await fixture();
  return {
    ...f,
    advance: (ms) => f.clock.advance(ms),
    identity: (a) => f.runtime.identity(a),
    stimulus: async (a, action) => {
      if (action === 'done') f.runtime.enqueue(a, { type: 'done' });
      if (action === 'ask-with-false-escalation')
        f.runtime.enqueue(
          a,
          { type: 'ask', body: 'Question?' },
          { type: 'false-escalation' },
        );
      if (action === 'turn-start-unobserved')
        f.runtime.enqueue(
          a,
          { type: 'turn-start-unobserved' },
          { type: 'false-escalation' },
        );
      await f.runtime.runDue();
    },
  };
});
describe('FakeRuntime scenarios and faults', () => {
  it('uses injected submitter, prompt token and caller identity; delays and pushes are deterministic', async () => {
    const submissions: unknown[] = [],
      pushes: unknown[] = [];
    const f = await fixture({
      submitter: (r) => {
        submissions.push(r);
      },
      onPush: (r) => {
        pushes.push(r);
      },
      scenario: {
        roles: {
          worker: {
            spawn: [
              {
                type: 'submit',
                afterMs: 10,
                submission: { kind: 'agenda', payload: { topics: [] } },
              },
              { type: 'push', afterMs: 20, branch: 'work', headSha: 'abcdef0' },
              { type: 'done', afterMs: 30 },
            ],
          },
        },
      },
    });
    const a = await f.runtime.spawnAgent(f.spawnRequest);
    await f.runtime.runDue();
    expect(submissions).toEqual([]);
    f.clock.advance(10);
    await f.runtime.runDue();
    expect(submissions).toEqual([
      {
        agent: a,
        ...f.runtime.identity(a),
        seatToken: 'aio_seat_test',
        submission: { kind: 'agenda', payload: { topics: [] } },
      },
    ]);
    f.clock.advance(20);
    await f.runtime.runDue();
    expect(pushes).toMatchObject([
      { agent: a, branch: 'work', headSha: 'abcdef0' },
    ]);
    const events = (await f.runtime.observe(f.session, null)).events;
    expect(events.at(-1)).toMatchObject({
      type: 'agent.done',
      occurredAt: '2026-01-01T00:00:00.030Z',
    });
    expect(JSON.stringify(events)).not.toContain('aio_seat_');
  });
  it.each(['lost', 'degraded', 'duplicate', 'unmanaged', 'policy'] as const)(
    'injects %s using valid port events',
    async (fault) => {
      const f = await fixture();
      const a = await f.runtime.spawnAgent(f.spawnRequest);
      if (fault === 'lost') f.runtime.enqueue(a, { type: 'lost' });
      if (fault === 'degraded')
        f.runtime.enqueue(a, { type: 'degraded', reason: 'source_changed' });
      if (fault === 'duplicate') f.runtime.enqueue(a, { type: 'duplicate' });
      if (fault === 'unmanaged')
        f.runtime.enqueue(a, { type: 'unmanaged', dispatch: 'rogue' });
      if (fault === 'policy')
        f.runtime.enqueue(a, {
          type: 'policy',
          command: 'git push origin main',
        });
      const { events } = await f.runtime.observe(f.session, null);
      events.forEach((e) => RuntimeEventSchema.parse(e));
      if (fault === 'lost') {
        expect(events.at(-1)).toMatchObject({
          type: 'agent.status',
          state: 'lost',
        });
        expect(f.runtime.activeAgents()).toEqual([]);
      }
      if (fault === 'degraded')
        expect(events.at(-1)).toMatchObject({
          type: 'agent.degraded',
          reason: 'source_changed',
        });
      if (fault === 'duplicate') expect(events[0]).toEqual(events[1]);
      if (fault === 'unmanaged')
        expect(events.at(-1)).toMatchObject({
          type: 'agent.unmanaged',
          dispatch: 'rogue',
          parentDispatch: a,
        });
      if (fault === 'policy')
        expect(events.at(-1)).toMatchObject({
          type: 'agent.output',
          blocks: [
            { type: 'tool_use', input: { command: 'git push origin main' } },
          ],
        });
    },
  );
  it('disconnect is transient with no side effect and health tracks availability', async () => {
    const f = await fixture();
    f.runtime.setConnected(false);
    expect(await f.runtime.health()).toMatchObject({ available: false });
    await expect(f.runtime.spawnAgent(f.spawnRequest)).rejects.toMatchObject({
      category: 'transient',
      retryable: true,
    });
    f.runtime.setConnected(true);
    expect(f.runtime.activeAgents()).toEqual([]);
    f.runtime.injectFault('spawnAgent', 'disconnect');
    await expect(f.runtime.spawnAgent(f.spawnRequest)).rejects.toMatchObject({
      category: 'transient',
    });
    await f.runtime.spawnAgent(f.spawnRequest);
    expect(f.runtime.activeAgents()).toHaveLength(1);
  });
  it('lost spawn response is recovered by correlation and retry without duplicate side effects', async () => {
    const f = await fixture();
    f.runtime.injectFault('spawnAgent', 'response-lost');
    await expect(f.runtime.spawnAgent(f.spawnRequest)).rejects.toMatchObject({
      code: 'response_lost',
    });
    const found = await f.runtime.findByCorrelation(f.session, 'spawn');
    expect(found).not.toBeNull();
    expect(await f.runtime.spawnAgent(f.spawnRequest)).toBe(found);
    expect(f.runtime.activeAgents()).toEqual([found]);
    const another = await f.runtime.openSession({
      workflowId: 'other',
      repo: f.repo,
      objective: '',
      correlation: { workflowId: 'other', commandId: 'other-open' },
    });
    expect(await f.runtime.findByCorrelation(another, 'spawn')).toBeNull();
  });
  it('lost observe response replays the committed batch and isolates returned objects', async () => {
    const f = await fixture();
    const a = await f.runtime.spawnAgent(f.spawnRequest);
    f.runtime.injectFault('observe', 'response-lost');
    await expect(f.runtime.observe(f.session, null)).rejects.toMatchObject({
      code: 'response_lost',
    });
    await f.runtime.stop(a);
    const first = await f.runtime.observe(f.session, null);
    expect(first.events).toHaveLength(1);
    first.events.length = 0;
    expect((await f.runtime.observe(f.session, null)).events).toHaveLength(1);
    expect(
      (await f.runtime.observe(f.session, first.cursor)).events,
    ).toMatchObject([{ type: 'agent.stopped' }]);
  });
  it('can ignore stop to expose live agents at a gate, but release still works', async () => {
    const f = await fixture({
      scenario: { roles: { worker: { ignoreStop: true } } },
    });
    const a = await f.runtime.spawnAgent(f.spawnRequest);
    await f.runtime.stop(a);
    expect(f.runtime.activeAgents()).toEqual([a]);
    expect(
      (await f.runtime.observe(f.session, null)).events.some(
        (e) => e.type === 'agent.stopped',
      ),
    ).toBe(false);
    await f.runtime.release(a, { removeWorkspace: false });
    expect(f.runtime.activeAgents()).toEqual([]);
  });
  it('configures repo and workspace inspection and preserves identity after release', async () => {
    const facts = {
      isGitMainWorktree: true,
      originUrl: 'https://github.com/example/repo.git',
      runtimeRepoId: 'repo',
    };
    const f = await fixture({ localRepos: { '/repo': facts } });
    expect(await f.runtime.inspectLocalRepo('/repo')).toEqual(facts);
    expect(await f.runtime.inspectLocalRepo('/absent')).toMatchObject({
      isGitMainWorktree: false,
      originUrl: null,
    });
    const req = {
      session: f.session,
      repo: f.repo,
      baseBranch: 'main',
      name: 'shared',
      branch: 'shared',
      correlation: { workflowId: 'wf', commandId: 'workspace' },
    };
    const ws = await f.runtime.prepareWorkspace(req);
    expect(await f.runtime.prepareWorkspace(req)).toBe(ws);
    f.runtime.setWorkspaceInspection(ws, {
      clean: false,
      changedFiles: ['changed.ts'],
    });
    expect(await f.runtime.inspectWorkspace(ws)).toEqual({
      clean: false,
      changedFiles: ['changed.ts'],
    });
    const a = await f.runtime.spawnAgent({
      ...f.spawnRequest,
      workspace: { kind: 'existing-worktree', workspace: ws, readOnly: true },
    });
    await f.runtime.release(a, { removeWorkspace: true });
    expect(await f.runtime.resolveCaller(f.runtime.identity(a))).toBe(a);
    expect(
      await f.runtime.resolveCaller({
        ...f.runtime.identity(a),
        paneKey: 'wrong',
      }),
    ).toBeNull();
    await expect(f.runtime.inspectWorkspace(ws)).rejects.toMatchObject({
      code: 'unknown_workspace',
    });
    await f.runtime.disposeWorkspace(ws);
    await f.runtime.closeSession(f.session);
  });
  it('send and answer retry once, cancel obsolete auto-release and use role turn scripts', async () => {
    const f = await fixture({
      scenario: {
        roles: {
          worker: {
            spawn: [{ type: 'done' }],
            send: (c) => [
              { type: 'ask', body: `turn ${c.turn}: ${c.message?.body}` },
            ],
            answer: [{ type: 'done' }],
          },
        },
      },
    });
    const a = await f.runtime.spawnAgent({
      ...f.spawnRequest,
      keepOpen: false,
    });
    await f.runtime.runDue();
    f.clock.advance(60_000);
    const msg = {
      subject: 'next',
      body: 'hello',
      correlation: { workflowId: 'wf', commandId: 'send' },
    };
    f.runtime.injectFault('send', 'response-lost');
    await expect(f.runtime.send(a, msg)).rejects.toMatchObject({
      code: 'response_lost',
    });
    await f.runtime.send(a, msg);
    await f.runtime.runDue();
    const batch = await f.runtime.observe(f.session, null);
    const q = batch.events.find((e) => e.type === 'agent.question');
    expect(q).toMatchObject({ body: 'turn 2: hello' });
    if (q?.type !== 'agent.question') throw new Error('Missing question');
    await f.runtime.answer(q.question, 'yes', {
      workflowId: 'wf',
      commandId: 'answer',
    });
    await f.runtime.answer(q.question, 'yes', {
      workflowId: 'wf',
      commandId: 'answer',
    });
    await f.runtime.runDue();
    f.clock.advance(60_000);
    await f.runtime.runDue();
    expect(f.runtime.activeAgents()).toEqual([a]);
    f.clock.advance(60_000);
    await f.runtime.runDue();
    expect(f.runtime.activeAgents()).toEqual([]);
  });
  it('stop cancels pending submissions and rejects malformed cursor/session combinations', async () => {
    const f = await fixture({
      scenario: {
        roles: {
          worker: {
            spawn: [
              {
                type: 'submit',
                afterMs: 1,
                submission: { kind: 'agenda', payload: { topics: [] } },
              },
            ],
          },
        },
      },
    });
    const a = await f.runtime.spawnAgent(f.spawnRequest);
    await f.runtime.stop(a);
    f.clock.advance(1);
    await f.runtime.runDue();
    const batch = await f.runtime.observe(f.session, null);
    const other = await f.runtime.openSession({
      workflowId: 'other',
      repo: f.repo,
      objective: '',
      correlation: { workflowId: 'other', commandId: 'other' },
    });
    await expect(f.runtime.observe(other, batch.cursor)).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
  });
});

describe('mainline example', () => {
  it('runs both meeting rounds, conclusion, planning, worker push and integration submissions', async () => {
    const { mainlineScenario } = await import('./mainline.js');
    const { AgentSubmissionSchema } =
      await import('@ai-office/contracts/agent-submission');
    const submissions: { title: string; kind: string; round?: number }[] = [];
    const titles = new Map<string, string>();
    const pushes: unknown[] = [];
    const f = await fixture({
      scenario: mainlineScenario,
      submitter: (r) => {
        const submission = AgentSubmissionSchema.parse(r.submission);
        submissions.push({
          title: titles.get(r.agent) ?? '',
          kind: submission.kind,
          ...(submission.kind === 'statement'
            ? { round: submission.payload.round }
            : {}),
        });
      },
      onPush: (r) => {
        pushes.push(r);
      },
    });
    const spawn = async (title: string) => {
      const agent = await f.runtime.spawnAgent({
        ...f.spawnRequest,
        title,
        correlation: { workflowId: 'wf', commandId: title },
      });
      titles.set(agent, title);
      return agent;
    };
    const pump = async () => {
      f.clock.advance(30);
      await f.runtime.runDue();
    };
    const facilitator = await spawn('facilitator');
    await pump();
    const participants = await Promise.all(
      ['pm', 'architect', 'engineer'].map(spawn),
    );
    await pump();
    for (let turn = 1; turn <= 3; turn++) {
      await f.runtime.send(facilitator, {
        subject: 'round',
        body: '',
        correlation: { workflowId: 'wf', commandId: `facilitator-${turn}` },
      });
      if (turn === 2)
        for (const a of participants)
          await f.runtime.send(a, {
            subject: 'round 2',
            body: '',
            correlation: { workflowId: 'wf', commandId: `${a}-round2` },
          });
      await pump();
    }
    for (const title of ['planner', 'worker', 'integrator']) {
      await spawn(title);
      await pump();
    }
    expect(submissions.map((s) => s.kind)).toEqual([
      'agenda',
      'statement',
      'statement',
      'statement',
      'statement',
      'statement',
      'statement',
      'statement',
      'statement',
      'conclusion',
      'work-items',
      'merge-request',
      'integration-report',
    ]);
    for (const title of ['facilitator', 'pm', 'architect', 'engineer'])
      expect(
        submissions
          .filter((s) => s.title === title && s.kind === 'statement')
          .map((s) => s.round),
      ).toEqual([1, 2]);
    expect(pushes).toHaveLength(1);
  });
  it('rejects submissions without one unambiguous credential instead of silently succeeding', async () => {
    const f = await fixture({
      submitter: () => {
        throw new Error('Must not submit');
      },
      scenario: {
        roles: {
          worker: {
            spawn: [
              {
                type: 'submit',
                submission: { kind: 'agenda', payload: { topics: [] } },
              },
            ],
          },
        },
      },
    });
    await f.runtime.spawnAgent({ ...f.spawnRequest, prompt: 'No credential' });
    await expect(f.runtime.runDue()).rejects.toMatchObject({
      code: 'missing_submitter_or_token',
    });
    await f.runtime.spawnAgent({
      ...f.spawnRequest,
      correlation: { workflowId: 'wf', commandId: 'ambiguous' },
      prompt: 'aio_seat_first aio_seat_second',
    });
    await expect(f.runtime.runDue()).rejects.toMatchObject({
      code: 'missing_submitter_or_token',
    });
  });
});

describe('clock and concurrency boundaries', () => {
  it('concurrent observation retries share a delivery and preserve queued output', async () => {
    let resume: () => void = () => {};
    const submitted = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const f = await fixture({
      submitter: () => submitted,
      scenario: {
        roles: {
          worker: {
            spawn: [
              {
                type: 'submit',
                submission: { kind: 'agenda', payload: { topics: [] } },
              },
              { type: 'done' },
            ],
          },
        },
      },
    });
    await f.runtime.spawnAgent(f.spawnRequest);
    const first = f.runtime.observe(f.session, null),
      retry = f.runtime.observe(f.session, null);
    resume();
    const [a, b] = await Promise.all([first, retry]);
    expect(a).toEqual(b);
    expect(a.events.at(-1)).toMatchObject({ type: 'agent.done' });
  });
  it('send observes an expired auto-release even without a preceding poll', async () => {
    const f = await fixture({
      scenario: { roles: { worker: { spawn: [{ type: 'done' }] } } },
    });
    const a = await f.runtime.spawnAgent({
      ...f.spawnRequest,
      keepOpen: false,
    });
    f.clock.advance(120_000);
    await expect(
      f.runtime.send(a, {
        subject: 'late',
        body: '',
        correlation: { workflowId: 'wf', commandId: 'late' },
      }),
    ).rejects.toMatchObject({ code: 'agent_not_live' });
    expect(f.runtime.activeAgents()).toEqual([]);
  });
});
