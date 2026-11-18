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
  const baseSha = 'a'.repeat(40);
  f.runtime.setRemoteBranch(f.repo, 'ai-office/integration', baseSha);
  f.runtime.setRemoteBranch(f.repo, 'ai-office/worker', 'b'.repeat(40));
  return {
    ...f,
    prepareRequest: {
      session: f.session,
      repo: f.repo,
      baseBranch: baseSha,
      baseSha,
      fetchBranch: 'ai-office/integration',
      name: 'worker',
      branch: 'ai-office/worker',
      correlation: { workflowId: 'wf', commandId: 'prepare' },
    },
    reworkRequest: {
      session: f.session,
      repo: f.repo,
      baseBranch: 'b'.repeat(40),
      fetchBranch: 'ai-office/worker',
      branch: 'ai-office/worker',
      name: 'worker-r1',
      checkoutExisting: true,
      correlation: { workflowId: 'wf', commandId: 'prepare-rework' },
    },
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
    const prepared = await f.runtime.prepareWorkspace(req);
    const ws = prepared.workspace;
    expect(await f.runtime.prepareWorkspace(req)).toEqual(prepared);
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
  it("answers the engine's turns: rounds, conclusion, planning, push, review and report", async () => {
    const { mainlineScenario } = await import('./mainline.js');
    const { AgentSubmissionSchema } =
      await import('@ai-office/contracts/agent-submission');
    const submissions: { role: string; kind: string; detail?: unknown }[] = [];
    const roles = new Map<string, string>();
    const pushes: unknown[] = [];
    const specs = new Map<string, string>();
    const f = await fixture({
      scenario: mainlineScenario,
      readSpec: (path) => specs.get(path) ?? null,
      submitter: (r) => {
        const submission = AgentSubmissionSchema.parse(r.submission);
        submissions.push({
          role: roles.get(r.agent) ?? '',
          kind: submission.kind,
          ...(submission.kind === 'statement'
            ? { detail: submission.payload.round }
            : submission.kind === 'merge-request'
              ? { detail: submission.payload }
              : {}),
        });
      },
      onPush: (r) => {
        pushes.push(r);
      },
    });
    const sha = 'c'.repeat(64);
    // Roles come from the spec the agent read, not the `aio:<commandId>` title.
    const spawn = async (role: string, specTitle: string) => {
      specs.set(
        `/specs/${role}.md`,
        `# AI Office spec: ${specTitle}\n\naio_seat_${role}\n`,
      );
      const agent = await f.runtime.spawnAgent({
        ...f.spawnRequest,
        title: `aio:${role}`,
        prompt: `aio:${role}\nRead the AI Office spec at /specs/${role}.md (sha256 ${sha}) and follow it exactly.`,
        correlation: { workflowId: 'wf', commandId: role },
      });
      roles.set(agent, role);
      return agent;
    };
    const send = async (
      agent: string,
      subject: string,
      body: string,
      id: string,
    ) => {
      await f.runtime.send(agent as never, {
        subject,
        body,
        correlation: { workflowId: 'wf', commandId: id },
      });
      await pump();
    };
    const pump = async () => {
      f.clock.advance(30);
      await f.runtime.runDue();
    };
    const lead = await spawn('lead', 'meeting facilitator');
    await pump();
    const pm = await spawn('pm', 'meeting participant (pm)');
    const architect = await spawn(
      'architect',
      'meeting participant (architect)',
    );
    await pump();
    for (const round of [1, 2])
      for (const agent of [pm, architect])
        await send(
          agent,
          `Meeting round ${round}`,
          JSON.stringify({ round }),
          `${agent}-${round}`,
        );
    // A prose reminder names the round, too.
    await send(
      pm,
      'Required turn output',
      'Complete round 2: submit the required artifact',
      'nudge',
    );
    await send(lead, 'Write meeting conclusion', '{}', 'conclude');
    await spawn('planner', 'planning lead');
    await pump();
    await spawn('worker', 'implementation worker (feature)');
    await pump();
    const reviewer = await spawn('merge-queue', 'merge-queue integrator');
    await pump();
    await send(
      reviewer,
      'Review feature',
      JSON.stringify({ itemKey: 'feature', pr: 4, headSha: 'a'.repeat(40) }),
      'review',
    );
    await spawn('integrator', 'integrator (wrap-up)');
    await pump();
    expect(submissions).toEqual([
      { role: 'lead', kind: 'agenda' },
      { role: 'pm', kind: 'statement', detail: 1 },
      { role: 'architect', kind: 'statement', detail: 1 },
      { role: 'pm', kind: 'statement', detail: 2 },
      { role: 'architect', kind: 'statement', detail: 2 },
      { role: 'pm', kind: 'statement', detail: 2 },
      { role: 'lead', kind: 'conclusion' },
      { role: 'planner', kind: 'work-items' },
      {
        role: 'merge-queue',
        kind: 'merge-request',
        detail: { pr: 4, expectedHeadSha: 'a'.repeat(40) },
      },
      { role: 'integrator', kind: 'integration-report' },
    ]);
    expect(pushes).toHaveLength(1);
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

describe('injected agent and Git behavior', () => {
  const sha256 = 'd'.repeat(64);
  const specPrompt = `aio:spawn\nRead the AI Office spec at /specs/a.md (sha256 ${sha256}) and follow it exactly.`;
  const submitStep = {
    type: 'submit' as const,
    submission: { kind: 'agenda' as const, payload: { topics: [] } },
  };

  it('reads the seat token from the spec named in the prompt', async () => {
    const tokens: string[] = [];
    const reads: [string, string][] = [];
    const f = await fixture({
      readSpec: (path, hash) => {
        reads.push([path, hash]);
        return '# AI Office spec: worker\n\nToken: aio_seat_fromspec\n';
      },
      submitter: (r) => {
        tokens.push(r.seatToken);
      },
      scenario: { roles: { worker: { spawn: [submitStep] } } },
    });
    await f.runtime.spawnAgent({ ...f.spawnRequest, prompt: specPrompt });
    await f.runtime.runDue();
    expect(reads).toEqual([['/specs/a.md', sha256]]);
    expect(tokens).toEqual(['aio_seat_fromspec']);
  });

  it('pushes the branch its workspace was prepared with, carrying the pinned base', async () => {
    const pushes: unknown[] = [];
    const base = 'b'.repeat(40);
    const f = await fixture({
      remoteHead: (ref) =>
        ref === 'integration' || ref === base ? base : null,
      onPush: (r) => {
        pushes.push({ branch: r.branch, base: r.base });
      },
      scenario: {
        roles: {
          worker: {
            spawn: [
              { type: 'push', branch: 'illustrative', headSha: 'e'.repeat(40) },
            ],
          },
        },
      },
    });
    const prepared = await f.runtime.prepareWorkspace({
      session: f.session,
      repo: f.repo,
      baseBranch: base,
      fetchBranch: 'integration',
      name: 'feature',
      branch: 'ai-office/wf/feature',
      correlation: { workflowId: 'wf', commandId: 'prepare' },
    });
    // remoteHead made the pinned commit fetchable without setRemoteBranch.
    expect(prepared.baseSha).toBe(base);
    await f.runtime.spawnAgent({
      ...f.spawnRequest,
      workspace: {
        kind: 'existing-worktree',
        workspace: prepared.workspace,
        readOnly: false,
      },
    });
    await f.runtime.runDue();
    expect(pushes).toEqual([{ branch: 'ai-office/wf/feature', base }]);
  });

  it('follows the remote head for an unpinned origin/<branch> base via remoteHead', async () => {
    let head = 'a'.repeat(40);
    const f = await fixture({ remoteHead: () => head });
    const prepare = (commandId: string) =>
      f.runtime.prepareWorkspace({
        session: f.session,
        repo: f.repo,
        baseBranch: 'origin/integration',
        fetchBranch: 'integration',
        name: commandId,
        branch: `ai-office/${commandId}`,
        correlation: { workflowId: 'wf', commandId },
      });
    expect((await prepare('first')).baseSha).toBe(head);
    head = 'f'.repeat(40);
    expect((await prepare('second')).baseSha).toBe(head);
  });

  it('retries a transient submit failure after submitRetryMs, and consumes others', async () => {
    const { PortError } = await import('../../ports/errors.js');
    let backendUp = false;
    const accepted: string[] = [];
    const f = await fixture({
      submitRetryMs: 1000,
      submitter: (r) => {
        if (!backendUp)
          throw new PortError('transient', 'backend_down', 'restarting');
        accepted.push(r.submission.kind);
      },
      scenario: { roles: { worker: { spawn: [submitStep] } } },
    });
    await f.runtime.spawnAgent(f.spawnRequest);
    await f.runtime.runDue();
    expect(accepted).toEqual([]);
    backendUp = true;
    f.clock.advance(999);
    await f.runtime.runDue();
    expect(accepted).toEqual([]);
    f.clock.advance(1);
    await f.runtime.runDue();
    expect(accepted).toEqual(['agenda']);

    // The rest of the turn waits behind the retried submit: no done before it.
    backendUp = false;
    const h = await fixture({
      submitRetryMs: 1000,
      submitter: (r) => {
        if (!backendUp)
          throw new PortError('transient', 'backend_down', 'restarting');
        accepted.push(r.submission.kind);
      },
      scenario: {
        roles: { worker: { spawn: [submitStep, { type: 'done' }] } },
      },
    });
    await h.runtime.spawnAgent(h.spawnRequest);
    const first = await h.runtime.observe(h.session, null);
    expect(first.events.map((e) => e.type)).not.toContain('agent.done');
    backendUp = true;
    h.clock.advance(1000);
    const next = await h.runtime.observe(h.session, first.cursor);
    expect(accepted).toEqual(['agenda', 'agenda']);
    expect(next.events.map((e) => e.type)).toContain('agent.done');

    const g = await fixture({
      submitRetryMs: 1000,
      submitter: () => {
        throw new PortError('validation', 'rejected', 'bad');
      },
      scenario: { roles: { worker: { spawn: [submitStep] } } },
    });
    await g.runtime.spawnAgent(g.spawnRequest);
    await expect(g.runtime.runDue()).rejects.toMatchObject({
      code: 'rejected',
    });
    g.clock.advance(5000);
    await expect(g.runtime.runDue()).resolves.toBeUndefined();
  });
});
