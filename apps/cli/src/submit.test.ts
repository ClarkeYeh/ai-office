import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { HTTP_STATUS_EXIT_CODES } from '@ai-office/contracts/agent-submission';
import { runCli } from './index.js';

let home: string;
let server: Server;
let env: NodeJS.ProcessEnv;
let status: number;
let body: unknown;
let received: {
  headers: IncomingHttpHeaders;
  url: string | undefined;
  method: string | undefined;
  body: unknown;
}[];
const payload = { questionId: 'q1', body: 'An answer.' };
const args = [
  'submit',
  'answer-question',
  '--seat-token',
  'aio_seat_test',
  '-',
];
let stall = false;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'aio-cli-'));
  status = 200;
  body = { status: 'accepted', submissionId: 's1' };
  received = [];
  stall = false;
  server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += String(chunk);
    received.push({
      headers: req.headers,
      url: req.url,
      method: req.method,
      body: JSON.parse(text),
    });
    if (stall) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  writeFileSync(
    join(home, 'runtime.json'),
    JSON.stringify({
      port: address.port,
      pid: process.pid,
      startedAt: '2026-11-17T00:00:00Z',
    }),
  );
  env = {
    AI_OFFICE_HOME: home,
    ORCA_TERMINAL_HANDLE: 'term_test',
    ORCA_PANE_KEY: 'pane_test',
    CODEX_THREAD_ID: 'codex_session',
  };
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  rmSync(home, { recursive: true, force: true });
});
const run = (input: unknown = payload) =>
  runCli(args, { env, readStdin: async () => JSON.stringify(input) });

test('posts payload with identity headers and no browser credentials', async () => {
  expect(await run()).toEqual({ exitCode: 0, message: JSON.stringify(body) });
  expect(received[0]).toMatchObject({
    url: '/agent/v1/submissions',
    method: 'POST',
    body: { kind: 'answer-question', payload },
    headers: {
      authorization: 'Bearer aio_seat_test',
      'x-aio-terminal-handle': 'term_test',
      'x-aio-pane-key': 'pane_test',
      'x-aio-agent-session': 'codex_session',
    },
  });
  expect(received[0]?.headers).not.toHaveProperty('origin');
  expect(received[0]?.headers).not.toHaveProperty('cookie');
});
test('prefers Claude session and supports missing Orca identity', async () => {
  env.CLAUDE_CODE_SESSION_ID = 'claude_session';
  delete env.ORCA_TERMINAL_HANDLE;
  delete env.ORCA_PANE_KEY;
  await run();
  expect(received[0]?.headers['x-aio-agent-session']).toBe('claude_session');
  expect(received[0]?.headers).not.toHaveProperty('x-aio-terminal-handle');
});
test.each(Object.entries(HTTP_STATUS_EXIT_CODES))(
  'maps HTTP %s to exit %s',
  async (code, exitCode) => {
    status = Number(code);
    expect((await run()).exitCode).toBe(exitCode);
  },
);
test('preserves pending response for merge retry', async () => {
  status = 202;
  body = { status: 'pending', submissionId: 's1' };
  expect(
    await runCli(
      ['submit', 'merge-request', '--seat-token', 'aio_seat_test', '-'],
      {
        env,
        readStdin: async () =>
          JSON.stringify({ pr: 1, expectedHeadSha: 'a'.repeat(40) }),
      },
    ),
  ).toEqual({ exitCode: 3, message: JSON.stringify(body) });
});
test('validates locally and emits structured issues without contacting backend', async () => {
  const result = await run({});
  expect(result.exitCode).toBe(2);
  expect(JSON.parse(result.message)).toEqual({
    issues: ['questionId', 'body'].map((field) => ({
      path: ['payload', field],
      code: 'invalid_type',
      message: expect.any(String),
    })),
  });
  expect(result.message).not.toContain('aio_seat_test');
  expect(received).toHaveLength(0);
});

test.each([
  { topics: [], path: ['payload', 'topics'], code: 'too_small' },
  {
    topics: [{ id: 't1', title: 42, focusByRole: {} }],
    path: ['payload', 'topics', 0, 'title'],
    code: 'invalid_type',
  },
])('reports agenda validation at $path', async ({ topics, path, code }) => {
  const result = await runCli(
    ['submit', 'agenda', '--seat-token', 'aio_seat_test', '-'],
    {
      env,
      readStdin: async () => JSON.stringify({ topics }),
    },
  );
  expect(result.exitCode).toBe(2);
  expect(JSON.parse(result.message)).toEqual({
    issues: [{ path, code, message: expect.any(String) }],
  });
  expect(received).toHaveLength(0);
});

test('redacts seat tokens in validation paths', async () => {
  const result = await runCli(
    ['submit', 'agenda', '--seat-token', 'aio_seat_test', '-'],
    {
      env,
      readStdin: async () =>
        JSON.stringify({
          topics: [
            { id: 't1', title: 'Topic', focusByRole: { aio_seat_test: 42 } },
          ],
        }),
    },
  );
  expect(result.exitCode).toBe(2);
  expect(result.message).not.toContain('aio_seat_test');
  expect(JSON.parse(result.message).issues[0].path).toEqual([
    'payload',
    'topics',
    0,
    'focusByRole',
    '[REDACTED]',
  ]);
});

test.each([400, 413, 422])(
  'normalizes backend validation status %s',
  async (code) => {
    status = code;
    body = {
      error: {
        details: {
          issues: [
            {
              path: ['payload', 'topics'],
              code: 'too_small',
              message: 'Invalid aio_seat_test',
              input: 'aio_seat_test',
            },
          ],
        },
      },
    };
    const result = await run();
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.message)).toEqual({
      issues: [
        {
          path: ['payload', 'topics'],
          code: 'too_small',
          message: 'Invalid [REDACTED]',
        },
      ],
    });
    body = { error: 'Invalid aio_seat_test' };
    const fallback = await run();
    expect(JSON.parse(fallback.message)).toEqual({
      issues: [{ path: [], code: 'custom', message: expect.any(String) }],
    });
    expect(fallback.message).not.toContain('aio_seat_test');
  },
);
test('reads a payload file', async () => {
  const file = join(home, 'payload.json');
  writeFileSync(file, JSON.stringify(payload));
  expect(
    (await runCli([...args.slice(0, -1), '--file', file], { env })).exitCode,
  ).toBe(0);
});
test.each(
  [[], ['-', '--file', 'file'], ['--file'], ['-', '-'], ['--unknown']].map(
    (input) => ({ input }),
  ),
)('rejects invalid input arguments %j', async ({ input }) => {
  const result = await runCli([...args.slice(0, -1), ...input], { env });
  expect(result.exitCode).toBe(2);
  expect(JSON.parse(result.message)).toEqual({
    issues: [{ path: [], code: 'custom', message: expect.any(String) }],
  });
  expect(result.message).not.toContain('aio_seat_test');
});
test('rejects unreadable files and invalid JSON', async () => {
  expect(
    (
      await runCli([...args.slice(0, -1), '--file', join(home, 'absent')], {
        env,
      })
    ).exitCode,
  ).toBe(2);
  expect(
    (await runCli(args, { env, readStdin: async () => '{' })).exitCode,
  ).toBe(2);
});
test('returns 4 for missing or malformed runtime', async () => {
  writeFileSync(join(home, 'runtime.json'), '{}');
  expect((await run()).exitCode).toBe(4);
  rmSync(join(home, 'runtime.json'));
  expect((await run()).exitCode).toBe(4);
});
test('returns 4 on refused connection and server error', async () => {
  status = 503;
  expect((await run()).exitCode).toBe(4);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect((await run()).exitCode).toBe(4);
  // Restart for common teardown.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
test('bounds stalled requests with environment timeout', async () => {
  stall = true;
  env.AI_OFFICE_SUBMIT_TIMEOUT_MS = '30';
  expect((await run()).exitCode).toBe(4);
});

test('uses HOME fallback and rejects invalid timeout without exposing identity', async () => {
  env = { HOME: home, AI_OFFICE_SUBMIT_TIMEOUT_MS: 'invalid' };
  const result = await run();
  expect(result.exitCode).toBe(2);
  expect(result.message).not.toContain('aio_seat_test');
  delete env.AI_OFFICE_SUBMIT_TIMEOUT_MS;
  expect((await run()).exitCode).toBe(4);
});

test('--home overrides the inherited data directory for agents spawned by Orca', async () => {
  // Agents inherit Orca's environment: AI_OFFICE_HOME and HOME point elsewhere.
  const elsewhere = mkdtempSync(join(tmpdir(), 'aio-cli-other-'));
  try {
    env = { ...env, AI_OFFICE_HOME: elsewhere, HOME: elsewhere };
    expect((await run()).exitCode).toBe(4);
    const withHome = [...args.slice(0, -1), '--home', home, '-'];
    expect(
      await runCli(withHome, {
        env,
        readStdin: async () => JSON.stringify(payload),
      }),
    ).toEqual({ exitCode: 0, message: JSON.stringify(body) });
    expect(received).toHaveLength(1);
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
test.each([
  [['--home', 'relative/dir']],
  [['--home', '/a', '--home', '/b']],
  [['--home']],
])(
  'rejects an invalid --home without contacting the backend: %o',
  async (extra) => {
    const result = await runCli([...args.slice(0, -1), ...extra, '-'], {
      env,
      readStdin: async () => JSON.stringify(payload),
    });
    expect(result.exitCode).toBe(2);
    expect(received).toHaveLength(0);
  },
);
