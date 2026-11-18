import { describe, expect, test, vi } from 'vitest';
import type { AgentSubmission } from '@ai-office/contracts/agent-submission';
import {
  Harness,
  eventDraft,
  meta,
  spawn,
  startCommand,
  startStage,
} from './test-support/fixtures.js';
import { reviewing, rework } from './test-support/fixtures.js';
import { AgentRefSchema } from '../../ports/refs.js';
import { ManualScheduler } from '../../test-support/services.js';
import { createRedactor } from '../../adapters/redactor/index.js';
import { harness, flush, StubWorld } from '../runner/test-support/harness.js';
import { WorkflowRunner } from '../runner/workflow-runner.js';
import type { RunnerReact } from '../runner/workflow-runner.js';
import { HandleSubmission } from './handle-submission.js';

const agenda: AgentSubmission = {
  kind: 'agenda',
  payload: { topics: [{ id: 'topic', title: 'Discussion', focusByRole: {} }] },
};
const merge: AgentSubmission = {
  kind: 'merge-request',
  payload: { pr: 11, expectedHeadSha: 'abcdef2' },
};
const redo: AgentSubmission = {
  kind: 'rework-request',
  payload: { pr: 11, reasons: ['Add edge tests'] },
};
const meeting = () =>
  new Harness().given(
    startCommand(),
    startStage('meeting'),
    spawn('a', 'lead', 'meeting', { purpose: 'facilitator' }),
  );
const mergeReact: RunnerReact = (_state, event) => {
  if (
    event.type !== 'submission.accepted' ||
    event.payload.submission.kind !== 'merge-request'
  )
    return [];
  return [
    {
      kind: 'external',
      commandId: `merge-${event.payload.submissionId}`,
      attemptId: event.payload.attemptId,
      stageId: 'implement',
      command: {
        kind: 'scm.mergePR',
        args: {
          pr: { repo: { owner: 'octo', name: 'demo' }, number: 11 },
          method: 'merge',
          expectedHeadSha: event.payload.submission.payload.expectedHeadSha,
        },
      },
    },
  ];
};
const setup = (
  domain = meeting(),
  react: RunnerReact = () => [],
  world = new StubWorld(),
) => {
  const h = harness({ world, react });
  h.store.append(domain.events);
  const attemptId = domain.state.attempts.merge ? 'merge' : 'a';
  const attempt = domain.state.attempts[attemptId]!;
  attempt.agentRef = 'agent-1';
  attempt.state = 'working';
  const runner = new WorkflowRunner(
    'wf-1',
    {
      ...h,
      cliPath: '/opt/ai-office/apps/cli/dist/main.js',
      react,
    },
    domain.state,
  );
  const runtime = {
    resolveCaller: vi.fn(async () => AgentRefSchema.parse('agent-1')),
  };
  const scheduler = new ManualScheduler(h.clock, (timer) =>
    useCase.onTimer(timer),
  );
  const deps = {
    ...h,
    runners: { all: () => [runner] },
    runtime,
    scheduler,
    redactor: createRedactor({ defaultBranch: 'main' }),
  };
  const useCase = new HandleSubmission(deps);
  const token = h.seatTokens.issue(attemptId);
  const headers = {
    authorization: `Bearer ${token}`,
    'x-aio-terminal-handle': 'terminal-1',
    'x-aio-pane-key': 'pane-1',
  };
  const accepted = () =>
    h.events().filter((e) => e.type === 'submission.accepted');
  return {
    ...h,
    runner,
    attempt,
    attemptId,
    runtime,
    scheduler,
    deps,
    useCase,
    headers,
    accepted,
  };
};

describe('submission identity, validation and artifacts', () => {
  test('checks both identities and never persists raw input on rejection', async () => {
    const h = setup();
    h.runtime.resolveCaller.mockResolvedValue(AgentRefSchema.parse('impostor'));
    expect(await h.useCase.handle(h.headers, agenda)).toMatchObject({
      status: 403,
      body: { error: 'identity_mismatch' },
    });
    expect(h.runtime.resolveCaller).toHaveBeenCalledWith({
      terminalHandle: 'terminal-1',
      paneKey: 'pane-1',
    });
    expect(h.accepted()).toHaveLength(0);
    expect(h.events().at(-1)).toMatchObject({
      type: 'submission.rejected',
      payload: { reason: 'identity_mismatch' },
    });
  });
  test('rejects revoked tokens, malformed headers and partial identities', async () => {
    const h = setup();
    expect(
      (
        await h.useCase.handle(
          {
            authorization: h.headers.authorization,
            'x-aio-terminal-handle': 't',
          },
          agenda,
        )
      ).status,
    ).toBe(403);
    h.seatTokens.revoke(h.attemptId);
    expect((await h.useCase.handle(h.headers, agenda)).status).toBe(401);
    expect((await h.useCase.handle({}, agenda)).status).toBe(401);
  });
  test('rechecks revocation after asynchronous identity lookup', async () => {
    const h = setup();
    h.runtime.resolveCaller.mockImplementation(async () => {
      h.seatTokens.revoke(h.attemptId);
      return AgentRefSchema.parse('agent-1');
    });
    expect((await h.useCase.handle(h.headers, agenda)).status).toBe(401);
  });
  test('Codex token-only uses authoritative nonterminal backend state; Claude cannot fall back', async () => {
    const h = setup();
    const headers = { authorization: h.headers.authorization };
    expect((await h.useCase.handle(headers, agenda)).status).toBe(403);
    h.attempt.agent = 'codex';
    expect((await h.useCase.handle(headers, agenda)).status).toBe(200);
    await h.runner.dispatch({
      type: 'ObserveAttemptStatus',
      meta: meta(),
      attemptId: h.attemptId,
      state: 'lost',
    });
    expect(
      (await h.useCase.handle(headers, agenda)).status,
    ).toBeGreaterThanOrEqual(400);
    expect(h.runtime.resolveCaller).not.toHaveBeenCalled();
  });
  test('schema errors provide structured issues; forbidden kind is a state error', async () => {
    const h = setup();
    expect(
      await h.useCase.handle(h.headers, {
        kind: 'agenda',
        payload: { topics: [] },
      }),
    ).toMatchObject({
      status: 400,
      body: { issues: [{ code: 'too_small', path: ['payload', 'topics'] }] },
    });
    expect(await h.useCase.handle(h.headers, merge)).toMatchObject({
      status: 409,
      body: { error: 'not_allowed' },
    });
  });
  test('masks artifacts without truncation and latest submission wins', async () => {
    const h = setup();
    const title = `${'Long artifact '.repeat(500)}person@example.com`;
    await h.useCase.handle(h.headers, {
      ...agenda,
      payload: { topics: [{ id: 't', title, focusByRole: {} }] },
    });
    await h.useCase.handle(h.headers, agenda);
    const events = h.accepted();
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('person@example.com');
    expect(JSON.stringify(events[0])).toContain('Long artifact '.repeat(500));
    expect(h.runner.state.attempts.a?.submissions.agenda).toBe(
      events[1]?.payload.submissionId,
    );
  });
  test('a stage gate rejects new submissions', async () => {
    const h = setup();
    await h.runner.append([
      eventDraft('gate.opened', {
        gateId: 'g',
        stageId: 'meeting',
        kind: 'stage',
        title: 'Review',
        stageKind: 'meeting',
        templateGateId: 'conclusion',
        version: 1,
        optional: false,
        content: {
          type: 'conclusion',
          artifactId: 'artifact',
          renderedHash: 'a'.repeat(64),
        },
        options: [],
      }),
    ]);
    expect(await h.useCase.handle(h.headers, agenda)).toMatchObject({
      status: 409,
      body: { error: 'gate_open' },
    });
  });
});

describe('progressive merge and rework', () => {
  test('implement merge waits for the matching ScmPort result', async () => {
    const h = setup(reviewing(), mergeReact);
    expect(await h.useCase.handle(h.headers, merge)).toMatchObject({
      status: 200,
      body: { status: 'merged', pr: 11, mergeCommitSha: 'abcdef1' },
    });
    expect(h.accepted()).toHaveLength(1);
  });
  test('120 seconds returns pending without blocking the actor; concurrent and restarted retries do not merge twice', async () => {
    const h = setup(reviewing(), mergeReact, new StubWorld().hang('mergePR'));
    const first = h.useCase.handle(h.headers, merge);
    const second = h.useCase.handle(h.headers, merge);
    await flush();
    expect(h.accepted()).toHaveLength(1);
    expect(
      await h.runner.dispatch({
        type: 'RejectSubmission',
        meta: meta(),
        rejection: { reason: 'not_allowed' },
      }),
    ).toMatchObject({ ok: true });
    h.clock.advance(119_999);
    h.scheduler.runDue();
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    h.clock.advance(1);
    h.scheduler.runDue();
    const pending = await first;
    expect(pending).toMatchObject({ status: 202, body: { status: 'pending' } });
    expect(await second).toEqual(pending);
    const issued = h
      .events()
      .find(
        (e) => e.type === 'command.issued' && e.payload.kind === 'scm.mergePR',
      );
    if (issued?.type !== 'command.issued')
      throw new Error('missing merge command');
    await h.runner.append([
      eventDraft('command.succeeded', {
        commandId: issued.payload.commandId,
        kind: 'scm.mergePR',
        result: { mergeCommitSha: 'abcdef3' },
      }),
    ]);
    const restarted = new HandleSubmission(h.deps);
    expect(await restarted.handle(h.headers, merge)).toMatchObject({
      status: 200,
      body: { status: 'merged', mergeCommitSha: 'abcdef3' },
    });
    expect(h.accepted()).toHaveLength(1);
    expect(
      h
        .events()
        .filter(
          (e) =>
            e.type === 'command.issued' && e.payload.kind === 'scm.mergePR',
        ),
    ).toHaveLength(1);
  });
  test('close releases all waits and racing acceptance, then a restarted query returns the result', async () => {
    const h = setup(reviewing(), mergeReact, new StubWorld().hang('mergePR'));
    const cancel = vi.spyOn(h.scheduler, 'cancel');
    const first = h.useCase.handle(h.headers, merge);
    const second = h.useCase.handle(h.headers, merge);
    await flush();
    h.useCase.close();
    h.useCase.close();
    const pending = await first;
    expect(pending).toMatchObject({ status: 202, body: { status: 'pending' } });
    expect(await second).toEqual(pending);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(await h.useCase.handle(h.headers, merge)).toEqual(pending);
    const issued = h
      .events()
      .find(
        (e) => e.type === 'command.issued' && e.payload.kind === 'scm.mergePR',
      );
    if (issued?.type !== 'command.issued') throw new Error('missing merge');
    await h.runner.append([
      eventDraft('command.succeeded', {
        commandId: issued.payload.commandId,
        kind: 'scm.mergePR',
        result: { mergeCommitSha: 'abcdef3' },
      }),
    ]);
    expect(
      await new HandleSubmission(h.deps).handle(h.headers, merge),
    ).toMatchObject({
      status: 200,
      body: { status: 'merged', mergeCommitSha: 'abcdef3' },
    });
    expect(h.accepted()).toHaveLength(1);
    const racing = setup(
      reviewing(),
      mergeReact,
      new StubWorld().hang('mergePR'),
    );
    const response = racing.useCase.handle(racing.headers, merge);
    racing.useCase.close();
    expect(await response).toMatchObject({
      status: 202,
      body: { status: 'pending' },
    });
  });
  test('matching failure returns 409, unrelated results do not finish the wait', async () => {
    const h = setup(reviewing(), mergeReact, new StubWorld().hang('mergePR'));
    const result = h.useCase.handle(h.headers, merge);
    await flush();
    const issued = h
      .events()
      .find(
        (e) => e.type === 'command.issued' && e.payload.kind === 'scm.mergePR',
      );
    if (issued?.type !== 'command.issued')
      throw new Error('missing merge command');
    await h.runner.append([
      eventDraft('command.failed', {
        commandId: issued.payload.commandId,
        kind: 'scm.mergePR',
        attempts: 1,
        error: {
          category: 'conflict',
          code: 'head_mismatch',
          message: 'Head moved',
          retryable: false,
        },
      }),
    ]);
    expect(await result).toMatchObject({
      status: 409,
      body: { status: 'failed', reason: 'head_mismatch' },
    });
  });
  test('rework is asynchronous and deduplicated even after current review advances', async () => {
    const h = setup(reviewing());
    const first = await h.useCase.handle(h.headers, redo);
    expect(first).toMatchObject({ status: 200, body: { status: 'accepted' } });
    const id = h.accepted()[0]!.payload.submissionId;
    expect(await h.runner.dispatch(rework(id))).toMatchObject({ ok: true });
    const original = h.runner.state.workItems.A!;
    await h.runner.dispatch({
      type: 'DispatchWorkItem',
      meta: meta(),
      itemKey: 'A',
      attemptId: 'worker-rework',
      baseSha: 'abcdef3',
    });
    expect(h.runner.state.workItems.A).toMatchObject({
      branch: original.branch,
      pr: 11,
      reworkOf: id,
      currentAttemptId: 'worker-rework',
    });
    const restarted = new HandleSubmission(h.deps);
    expect(await restarted.handle(h.headers, redo)).toEqual(first);
    expect(h.accepted()).toHaveLength(1);
    expect(h.runner.state.workItems.A).toMatchObject({
      pr: 11,
      reworkRequest: { submissionId: id },
      rework: 1,
    });
  });
  test.each([merge, redo])(
    'rejects non-queue attempts and wrong PR: $kind',
    async (submission) => {
      const h = setup(reviewing());
      expect(
        (
          await h.useCase.handle(h.headers, {
            ...submission,
            payload: { ...submission.payload, pr: 99 },
          })
        ).status,
      ).toBe(409);
      h.attempt.ondemand = { purpose: 'oncall' } as typeof h.attempt.ondemand;
      expect((await h.useCase.handle(h.headers, submission)).status).toBe(409);
    },
  );
});

test.each(['claude-code', 'codex'] as const)(
  'records %s session headers on first/change and retains them when omitted',
  async (agent) => {
    const h = setup();
    h.attempt.agent = agent;
    const provider = agent === 'codex' ? 'codex' : 'claude';
    const headers = { ...h.headers, 'x-aio-agent-session': 'session-one' };
    await h.useCase.handle(headers, agenda);
    expect(h.accepted().at(-1)?.payload.agentSession).toEqual({
      provider,
      id: 'session-one',
    });
    await h.useCase.handle(headers, agenda);
    expect(h.accepted().at(-1)?.payload.agentSession).toBeUndefined();
    await h.useCase.handle(
      { ...headers, 'x-aio-agent-session': 'session-two' },
      agenda,
    );
    expect(h.runner.state.attempts.a?.agentSession).toEqual({
      provider,
      id: 'session-two',
    });
    await h.useCase.handle(h.headers, agenda);
    expect(h.runner.state.attempts.a?.agentSession).toEqual({
      provider,
      id: 'session-two',
    });
  },
);
