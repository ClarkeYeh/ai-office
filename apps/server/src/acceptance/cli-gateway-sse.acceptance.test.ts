import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLI_EXIT_CODES } from '@ai-office/contracts/agent-submission';
import type { FakeSubmission } from '../adapters/runtime-fake/index.js';
import {
  conclusion,
  implementation,
} from '../adapters/runtime-fake/mainline-actions.js';
import { mainlineScenario } from '../adapters/runtime-fake/mainline.js';
import { startServer } from '../main.js';
import {
  closeAll,
  isEnded,
  office,
  sleep,
  tempHome,
  until,
} from './test-support/harness.js';
import type { Json } from './test-support/harness.js';

afterEach(async () => {
  vi.useRealTimers();
  await closeAll();
});

const CLI = join(import.meta.dirname, '../../../cli/dist/main.js');

/**
 * The built CLI entry (`apps/cli/dist/main.js submit …`, §9.2) with its own
 * argv, environment, stdin, stdout and exit code. It runs on a worker thread:
 * server code may not spawn processes (depcruise), and the entry only uses
 * process.argv/env/stdin/stdout/exitCode, which a worker isolates.
 */
function cli(
  args: string[],
  env: Record<string, string>,
  stdin: string,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(CLI, {
      argv: args,
      env,
      stdin: true,
      stdout: true,
      stderr: true,
    });
    let stdout = '';
    worker.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    worker.stderr.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    worker.on('error', reject);
    worker.on('exit', (code) => resolve({ code, stdout: stdout.trim() }));
    worker.stdin!.end(stdin);
  });
}

/** Reads SSE frames until `count` arrive (or the server ends the stream). */
async function sse(
  url: string,
  cookie: string,
  headers: Record<string, string>,
  count: number,
): Promise<{ event: string; id?: number; data: Json }[]> {
  const abort = new AbortController();
  const response = await fetch(url, {
    headers: { cookie, ...headers },
    signal: abort.signal,
  });
  expect(response.status).toBe(200);
  const frames: { event: string; id?: number; data: Json }[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = response.body!.getReader();
  try {
    while (frames.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf('\n\n'); end >= 0;) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf('\n\n');
        if (block.startsWith(':')) continue; // keepalive comment
        const field = (name: string) =>
          /^(\w+): (.*)$/gm.exec(block) &&
          [...block.matchAll(/^(\w+): (.*)$/gm)].find(
            (m) => m[1] === name,
          )?.[2];
        const id = field('id');
        frames.push({
          event: field('event') ?? 'message',
          ...(id === undefined ? {} : { id: Number(id) }),
          data: JSON.parse(field('data') ?? 'null') as Json,
        });
        // One read can carry many frames: return exactly `count`.
        if (frames.length === count) break;
      }
    }
  } finally {
    abort.abort();
  }
  return frames;
}

describe(
  'M1 acceptance: agent gateway, CLI, SSE and redaction',
  { timeout: 60_000 },
  () => {
    it('runs the built CLI entry against the gateway: exit 0/2/3/4, and a merge-request pending (202, exit 3) re-queried to merged', async () => {
      expect(existsSync(CLI), 'pnpm -r build first').toBe(true);
      // The server's 120 s merge wait is jumped with fake timers.
      vi.useFakeTimers({
        shouldAdvanceTime: true,
        toFake: ['Date', 'setTimeout', 'clearTimeout'],
      });
      let releaseMerge: (() => void) | undefined;
      // Once its queue drains, the backend stops and releases the integrator;
      // a released seat is (correctly) refused. Hold those calls for the
      // integrator until the CLI re-query has been answered.
      const integrator: { agent?: unknown } = {};
      let integratorDone!: () => void;
      const requeried = new Promise<void>(
        (resolve) => (integratorDone = resolve),
      );
      const o = await office({
        intercept: async (operation, args, call) => {
          if (
            (operation === 'stop' || operation === 'release') &&
            integrator.agent !== undefined &&
            args[0] === integrator.agent
          )
            await requeried;
          return call();
        },
        // The first worker merge is held until the test releases it.
        mergeDelay: () =>
          releaseMerge === undefined
            ? new Promise<void>((resolve) => (releaseMerge = resolve))
            : Promise.resolve(),
      });
      o.world.scm.setMergeDelay(1);
      // The merge-queue integrator's first merge-request goes through the CLI.
      const real = o.world.backend!;
      let captured: FakeSubmission | undefined;
      o.world.backend = {
        submit: async (request) => {
          if (request.submission.kind === 'merge-request' && !captured) {
            captured = request;
            return;
          }
          return real.submit(request);
        },
      };
      const workflowId = await o.start();
      await o.drive(workflowId, async () => captured !== undefined);
      const request = captured!;
      integrator.agent = request.agent;
      const env = {
        AI_OFFICE_HOME: o.dataDir,
        ORCA_TERMINAL_HANDLE: request.terminalHandle,
        ORCA_PANE_KEY: request.paneKey,
      };
      const payload = JSON.stringify(
        (
          request.submission as Extract<
            FakeSubmission['submission'],
            { kind: 'merge-request' }
          >
        ).payload,
      );
      const submit = (token: string, body = payload, extra = {}) =>
        cli(
          ['submit', 'merge-request', '--seat-token', token, '-'],
          { ...env, ...extra },
          body,
        );

      // 2: schema error, caught by the CLI before any request.
      const invalid = await submit(request.seatToken, '{"pr":"four"}');
      expect(invalid.code).toBe(CLI_EXIT_CODES.SCHEMA_ERROR);
      expect(invalid.stdout).not.toContain(request.seatToken);
      // 3: identity error (unknown token), and the token is never echoed.
      const forged = await submit(`aio_seat_${'x'.repeat(43)}`);
      expect(forged.code).toBe(CLI_EXIT_CODES.IDENTITY_OR_STATE_ERROR);
      // 4: no backend (no runtime.json in this home).
      const offline = await submit(request.seatToken, payload, {
        AI_OFFICE_HOME: tempHome(),
      });
      expect(offline.code).toBe(CLI_EXIT_CODES.BACKEND_UNREACHABLE);

      // The real merge-request: the merge is held past the 120 s wait → 202.
      const pending = submit(request.seatToken);
      await until(
        async () => releaseMerge,
        (r) => r !== undefined,
        'the merge to start',
      );
      vi.advanceTimersByTime(121_000);
      const first = await pending;
      expect(first.code).toBe(CLI_EXIT_CODES.IDENTITY_OR_STATE_ERROR);
      expect(JSON.parse(first.stdout)).toMatchObject({ status: 'pending' });
      expect(first.stdout).not.toContain(request.seatToken);

      // The merge completes; resubmitting the same content queries the result.
      releaseMerge!();
      await until(
        () => o.events(workflowId),
        (events) => events.some((e) => e.type === 'workitem.merged'),
        'the merge',
      );
      const again = await submit(request.seatToken);
      integratorDone(); // now the drained queue may stop the integrator
      expect(again.code, again.stdout).toBe(CLI_EXIT_CODES.SUCCESS);
      expect(JSON.parse(again.stdout)).toMatchObject({
        status: 'merged',
        pr: (JSON.parse(payload) as Json).pr,
      });
      const final = await o.drive(workflowId, isEnded);
      expect(final.status).toBe('completed');
      // One accepted merge-request for that PR despite three deliveries.
      expect(
        (await o.events(workflowId)).filter(
          (e) =>
            e.type === 'submission.accepted' &&
            e.payload.kind === 'merge-request' &&
            e.payload.submission.payload.pr ===
              (JSON.parse(payload) as Json).pr,
        ),
      ).toHaveLength(1);
    });

    it('refuses browser-origin /agent/v1 requests and a second backend on the same data directory', async () => {
      const o = await office();
      const gateway = await fetch(`${o.server.url}/agent/v1/submissions`, {
        method: 'POST',
        headers: { origin: o.server.url, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(gateway.status).toBe(403);
      await expect(
        startServer({
          dev: true,
          fake: 'mainline',
          port: 0,
          env: { AI_OFFICE_HOME: o.dataDir },
          print: () => undefined,
        }),
      ).rejects.toThrow(String(process.pid));
      expect(
        JSON.parse(readFileSync(join(o.dataDir, 'runtime.json'), 'utf8')),
      ).toMatchObject({ port: o.server.port });
    });

    it('resumes SSE from Last-Event-ID without gaps, and sends resync_required to a client too far behind', async () => {
      const o = await office();
      const workflowId = await o.start();
      await o.drive(workflowId, isEnded);
      const events = await o.events(workflowId);
      const middle = events[Math.floor(events.length / 2)]!.seq as number;

      const resumed = await sse(
        `${o.server.url}/api/v1/stream?workflowId=${workflowId}`,
        o.ui.cookie,
        { 'last-event-id': String(middle) },
        10,
      );
      expect(resumed.map((f) => f.event)).toEqual(Array(10).fill('domain'));
      expect(resumed.map((f) => f.id)).toEqual(
        events
          .filter((e) => (e.seq as number) > middle)
          .slice(0, 10)
          .map((e) => e.seq),
      );
      // Last-Event-ID wins over a stale query cursor.
      const header = await sse(
        `${o.server.url}/api/v1/stream?workflowId=${workflowId}&afterSeq=0`,
        o.ui.cookie,
        { 'last-event-id': String(middle) },
        1,
      );
      expect(header[0]!.id).toBe(resumed[0]!.id);

      // Three more workflows (one at a time: one slot per repository) push the
      // global backlog past 1000 events.
      for (let i = 0; i < 3; i++) await o.drive(await o.start(), isEnded);
      const behind = await sse(
        `${o.server.url}/api/v1/stream`,
        o.ui.cookie,
        { 'last-event-id': '0' },
        5,
      );
      expect(behind.map((f) => f.event)).toEqual(['resync_required']);
      expect(behind[0]!.data).toMatchObject({ reason: 'slow_client' });
    });

    it('keeps fake secrets from submissions and agent output out of the database and logs', async () => {
      const secrets = {
        email: 'mallory.secret@example.com',
        token: 'ghp_FAKEfake0123456789abcdefFAKEfake0123',
        key: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAFAKEFAKE\n-----END OPENSSH PRIVATE KEY-----',
        seat: 'aio_seat_FAKEleakedSeatToken0123456789abcdefXYZ',
      };
      const leak = `email ${secrets.email} token ${secrets.token} seat ${secrets.seat}\n${secrets.key}`;
      const [concluded] = conclusion as unknown as [{ submission: Json }];
      const o = await office({
        roles: {
          facilitator: {
            ...mainlineScenario.roles.facilitator,
            send: (context) =>
              /conclusion/i.test(
                `${context.message?.subject} ${context.message?.body}`,
              )
                ? [
                    {
                      type: 'output',
                      afterMs: 5,
                      blocks: [
                        { type: 'text', text: leak },
                        {
                          type: 'tool_use',
                          id: 'tool-1',
                          name: 'shell',
                          input: { command: `echo ${secrets.token}` },
                        },
                      ],
                    },
                    {
                      type: 'submit',
                      afterMs: 10,
                      submission: {
                        kind: 'conclusion',
                        payload: {
                          ...concluded.submission.payload,
                          summary: `Ship it. ${leak}`,
                        },
                      } as never,
                    },
                    { type: 'done', afterMs: 20 },
                  ]
                : (
                    mainlineScenario.roles.facilitator!.send as (
                      c: typeof context,
                    ) => never
                  )(context),
          },
          worker: {
            spawn: [
              { type: 'ask', afterMs: 5, body: `Is ${secrets.email} ok?` },
            ],
            answer: implementation,
          },
          oncall: {
            spawn: [{ type: 'done', afterMs: 5 }],
            send: (context) => [
              {
                type: 'submit',
                afterMs: 5,
                submission: {
                  kind: 'answer-question',
                  payload: {
                    questionId: (JSON.parse(context.message!.body) as Json)
                      .questionId,
                    body: `Use ${secrets.token}`,
                  },
                },
              },
            ],
          },
        },
      });
      // Real seat tokens issued in this run must not be stored either.
      const real = o.world.backend!;
      const seatTokens = new Set<string>();
      o.world.backend = {
        submit: (request) => {
          seatTokens.add(request.seatToken);
          return real.submit(request);
        },
      };
      const workflowId = await o.start();
      const final = await o.drive(workflowId, isEnded);
      expect(final.status).toBe('completed');
      await sleep(300);
      expect(seatTokens.size).toBeGreaterThan(3);
      await o.close();

      const files = [
        ...readdirSync(join(o.dataDir, 'data'))
          .filter((f) => f.startsWith('ai-office.sqlite'))
          .map((f) => join(o.dataDir, 'data', f)),
        ...readdirSync(join(o.dataDir, 'logs')).map((f) =>
          join(o.dataDir, 'logs', f),
        ),
      ];
      expect(files.length).toBeGreaterThanOrEqual(2);
      const needles = [
        secrets.email,
        secrets.token,
        secrets.seat,
        'PRIVATE KEY-----\nb3Bl',
        'b3BlbnNzaC1rZXktdjEAAAAAFAKEFAKE',
        ...seatTokens,
      ];
      for (const file of files) {
        const bytes = readFileSync(file);
        for (const needle of needles)
          expect(
            bytes.includes(Buffer.from(needle)),
            `${needle.slice(0, 12)}… in ${file}`,
          ).toBe(false);
      }
    });
  },
);
