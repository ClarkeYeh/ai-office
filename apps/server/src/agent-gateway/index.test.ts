import Fastify from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { exitCodeForHttpStatus } from '@ai-office/contracts/agent-submission';
import { registerAgentGateway } from './index.js';
import { HandleSubmission } from '../application/submissions/handle-submission.js';
import { WorkflowRunner } from '../application/runner/workflow-runner.js';
import {
  Harness,
  startCommand,
  startStage,
  spawn,
  reviewing,
  eventDraft,
} from '../application/submissions/test-support/fixtures.js';
import { harness, flush } from '../application/runner/test-support/harness.js';
import { ManualScheduler } from '../test-support/services.js';
import { AgentRefSchema } from '../ports/refs.js';
import { createRedactor } from '../adapters/redactor/index.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const agenda = {
  kind: 'agenda',
  payload: { topics: [{ id: 'topic', title: 'Discuss', focusByRole: {} }] },
};
const merge = {
  kind: 'merge-request',
  payload: { pr: 11, expectedHeadSha: 'abcdef2' },
};
function setup(merging = false) {
  const h = harness({ react: () => [] });
  const domain = merging
    ? reviewing()
    : new Harness().given(
        startCommand(),
        startStage('meeting'),
        spawn('a', 'lead', 'meeting', { purpose: 'facilitator' }),
      );
  h.store.append(domain.events);
  const attemptId = merging ? 'merge' : 'a';
  domain.state.attempts[attemptId]!.agentRef = 'agent-1';
  domain.state.attempts[attemptId]!.state = 'working';
  const runner = new WorkflowRunner(
    'wf-1',
    { ...h, cliPath: '/opt/cli.js', react: () => [] },
    domain.state,
  );
  const runtime = {
    resolveCaller: vi.fn(
      async (): Promise<ReturnType<typeof AgentRefSchema.parse> | null> =>
        AgentRefSchema.parse('agent-1'),
    ),
  };
  const scheduler = new ManualScheduler(h.clock, (timer) =>
    useCase.onTimer(timer),
  );
  const useCase = new HandleSubmission({
    ...h,
    runners: { all: () => [runner] },
    runtime,
    scheduler,
    redactor: createRedactor({ defaultBranch: 'main' }),
  });
  const headers = {
    host: '127.0.0.1:4319',
    authorization: `Bearer ${h.seatTokens.issue(attemptId)}`,
    'x-aio-terminal-handle': 'terminal-1',
    'x-aio-pane-key': 'pane-1',
  };
  const app = Fastify();
  apps.push(app);
  registerAgentGateway(app, { submissions: useCase, port: 4319 });
  const post = (payload: unknown = agenda, overrides = {}) =>
    app.inject({
      method: 'POST',
      url: '/agent/v1/submissions',
      headers: { ...headers, ...overrides },
      payload: JSON.stringify(payload),
    });
  // Explicit JSON is needed for the raw-string helper above.
  Object.assign(headers, { 'content-type': 'application/json' });
  return { ...h, app, headers, post, runtime, scheduler, runner };
}

describe('agent HTTP boundary', () => {
  test.each(['http://localhost:4319', 'null', ''])(
    'rejects every Origin value %j before parsing',
    async (origin) => {
      const h = setup();
      const response = await h.app.inject({
        method: 'POST',
        url: '/agent/v1/submissions',
        headers: { ...h.headers, origin },
        payload: '{bad json',
      });
      expect(response.statusCode).toBe(403);
      expect(h.runtime.resolveCaller).not.toHaveBeenCalled();
    },
  );
  test.each([
    'evil.test:4319',
    '127.0.0.1:9999',
    'localhost',
    'localhost:4319.evil.test',
    'localhost:4319,evil.test',
  ])('rejects Host %s even with trusted forwarded host', async (host) => {
    const h = setup();
    expect(
      (await h.post(agenda, { host, 'x-forwarded-host': 'localhost:4319' }))
        .statusCode,
    ).toBe(403);
  });
  test('keeps browser routes outside the agent security scope and rejects unknown agent routes with Origin', async () => {
    const h = setup();
    h.app.get('/api/probe', async () => ({ ok: true }));
    expect(
      (
        await h.app.inject({
          url: '/api/probe',
          headers: { origin: 'http://localhost' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await h.app.inject({
          method: 'OPTIONS',
          url: '/agent/v1/submissions',
          headers: { ...h.headers, origin: '' },
        })
      ).statusCode,
    ).toBe(403);
  });
  test('cookie alone is not identity; valid local agent submissions succeed', async () => {
    const h = setup();
    expect(
      (
        await h.post(agenda, {
          authorization: '',
          cookie: 'aio_session=session',
        })
      ).statusCode,
    ).toBe(401);
    const response = await h.post(agenda, { host: 'localhost:4319' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'accepted' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
  test('schema errors map to exit 2 and identity mismatches to exit 3', async () => {
    const h = setup();
    const invalid = await h.post({ kind: 'agenda', payload: { topics: [] } });
    expect(exitCodeForHttpStatus(invalid.statusCode)).toBe(2);
    expect(invalid.json().issues.length).toBeGreaterThan(0);
    h.runtime.resolveCaller.mockResolvedValue(null);
    const mismatch = await h.post();
    expect(mismatch.statusCode).toBe(403);
    expect(exitCodeForHttpStatus(mismatch.statusCode)).toBe(3);
  });
  test('malformed JSON never echoes submitted secrets', async () => {
    const h = setup();
    const response = await h.app.inject({
      method: 'POST',
      url: '/agent/v1/submissions',
      headers: h.headers,
      payload: '{"secret":"aio_seat_private" invalid}',
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('aio_seat_private');
  });
  test('parser and application failures do not disclose tokens or bodies in responses or logs', async () => {
    const logs: string[] = [];
    const secret = 'aio_seat_do_not_disclose';
    const app = Fastify({
      bodyLimit: 128,
      logger: {
        level: 'trace',
        stream: {
          write: (line: string) => {
            logs.push(line);
          },
        },
      },
    });
    apps.push(app);
    registerAgentGateway(app, {
      port: () => 4319,
      submissions: {
        handle: async () => {
          throw new Error(secret);
        },
      },
    });
    const headers = {
      host: 'localhost:4319',
      authorization: 'Bearer ' + secret,
      'content-type': 'application/json',
    };
    for (const [payload, expectedStatus] of [
      [JSON.stringify({ secret }), 500],
      ['{"secret":"' + secret, 400],
      [JSON.stringify({ secret: secret.repeat(20) }), 413],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/agent/v1/submissions',
        headers,
        payload,
      });
      expect(response.statusCode).toBe(expectedStatus);
      expect(response.body).not.toContain(secret);
    }
    expect(logs.join('')).not.toContain(secret);
  });
  test('merge wait returns 202 at 120 s and unchanged retry observes result without accepting twice', async () => {
    const h = setup(true);
    await h.app.ready();
    const pending = h.post(merge);
    // Start inject before advancing the manual scheduler.
    const responsePromise = pending.then((response) => response);
    await flush();
    expect(
      h.events().filter((e) => e.type === 'submission.accepted'),
    ).toHaveLength(1);
    h.clock.advance(120_000);
    h.scheduler.runDue();
    const response = await responsePromise;
    expect(response.statusCode).toBe(202);
    expect(exitCodeForHttpStatus(response.statusCode)).toBe(3);
    const submissionId = response.json().submissionId as string;
    await h.runner.append([
      {
        ...eventDraft('command.issued', {
          commandId: 'merge-command',
          kind: 'scm.mergePR',
          args: {
            pr: { repo: { owner: 'octo', name: 'demo' }, number: 11 },
            method: 'merge',
            expectedHeadSha: 'abcdef2',
          },
        }),
        attemptId: 'merge',
      },
      eventDraft('command.succeeded', {
        commandId: 'merge-command',
        kind: 'scm.mergePR',
        result: { mergeCommitSha: 'abcdef3' },
      }),
    ]);
    const retry = await h.post(merge);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ status: 'merged', submissionId });
    expect(
      h.events().filter((e) => e.type === 'submission.accepted'),
    ).toHaveLength(1);
  });
});
