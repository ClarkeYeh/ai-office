import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitize } from '@ai-office/redaction';
import { afterEach, expect, it } from 'vitest';
import { createPinoLogger } from './index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aio-logger-'));
  roots.push(root);
  let time = new Date('2026-11-17T23:59:59Z');
  const logger = createPinoLogger({
    dataDir: root,
    redactor: { maskSecrets: <T>(value: T): T => sanitize(value) as T },
    clock: { now: () => time },
  });
  return {
    root,
    logger,
    advance: () => {
      time = new Date('2026-11-18T00:00:00Z');
    },
  };
}
it('masks serialized errors, child bindings, nested fields, and messages while retaining required context', () => {
  const { root, logger } = setup();
  const token = 'aio_seat_fake_test_secret';
  logger.info({}, 'start');
  const child = logger
    .child({ workflowId: 'w1', commandId: 'c1', token })
    .child({ attemptId: 'a1', seatId: 's1', correlationId: 'corr1' });
  child.warn(
    {
      nested: { token },
      body: 'raw submission',
      transcript: 'raw transcript',
      err: new Error(token),
    },
    `failure ${token}`,
  );
  child.error({ detail: token }, 'failed');
  const raw = readFileSync(join(root, 'logs', 'server-20261117.log'), 'utf8');
  expect(raw).not.toContain(token);
  expect(raw).not.toContain('raw submission');
  expect(raw).not.toContain('raw transcript');
  const lines = raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(lines[0]).toMatchObject({
    workflowId: null,
    commandId: null,
    attemptId: null,
    seatId: null,
    correlationId: null,
  });
  expect(lines[1]).toMatchObject({
    level: 40,
    workflowId: 'w1',
    commandId: 'c1',
    attemptId: 'a1',
    seatId: 's1',
    correlationId: 'corr1',
  });
  expect(lines[2].level).toBe(50);
});
it('rotates on UTC midnight and keeps exactly the last 14 calendar days without deleting unrelated files', () => {
  const { root, logger, advance } = setup();
  const dir = join(root, 'logs');
  mkdirSync(dir, { recursive: true });
  for (const day of ['20261103', '20261104', '20261105'])
    writeFileSync(join(dir, `server-${day}.log`), 'old');
  writeFileSync(join(dir, 'other.log'), 'keep');
  logger.info({}, 'before');
  expect(readdirSync(dir)).not.toContain('server-20261103.log');
  expect(readdirSync(dir)).toContain('server-20261104.log');
  advance();
  logger.child({ workflowId: 'w' }).info({}, 'after');
  expect(readdirSync(dir).sort()).toEqual([
    'other.log',
    'server-20261105.log',
    'server-20261117.log',
    'server-20261118.log',
  ]);
  expect(readFileSync(join(dir, 'server-20261117.log'), 'utf8')).toContain(
    'before',
  );
  expect(readFileSync(join(dir, 'server-20261118.log'), 'utf8')).toContain(
    'after',
  );
});
