import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { acquireInstanceLock } from './instance-lock.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function home() {
  const path = mkdtempSync(join(tmpdir(), 'aio-control-'));
  homes.push(path);
  return path;
}

test('only a lock holder rotates atomically, keeps a hash verifier, and removes the token on close', () => {
  const path = home();
  const lock = acquireInstanceLock(path);
  try {
    const verify = lock.rotateControlToken();
    const token = readFileSync(`${path}/data/control.token`, 'utf8');
    expect(token).toMatch(/^aio_ctl_[a-f0-9]{64}$/);
    expect(statSync(`${path}/data/control.token`).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}/data`).mode & 0o777).toBe(0o700);
    expect(verify(token)).toBe(true);
    expect(verify('incorrect')).toBe(false);
    const runtime = lock.writeRuntime(4321);
    expect(JSON.stringify(runtime)).not.toContain('token');
    expect(() => acquireInstanceLock(path)).toThrow('already running');
    expect(
      readdirSync(`${path}/data`).filter((file) => file.endsWith('.tmp')),
    ).toEqual([]);
  } finally {
    lock.release();
  }
  expect(existsSync(`${path}/data/control.token`)).toBe(false);
  expect(() => lock.rotateControlToken()).toThrow('lock holder');
});

test('a stale lock and token left by an unclean exit do not block restart', () => {
  const path = home();
  const initial = acquireInstanceLock(path);
  const oldVerify = initial.rotateControlToken();
  const staleToken = readFileSync(`${path}/data/control.token`, 'utf8');
  initial.release();
  writeFileSync(
    `${path}/data/.lock`,
    JSON.stringify({ pid: process.pid, startedAt: '2026-01-01T00:00:00Z' }),
  );
  writeFileSync(`${path}/data/control.token`, staleToken);
  const restarted = acquireInstanceLock(path);
  try {
    const verify = restarted.rotateControlToken();
    const token = readFileSync(`${path}/data/control.token`, 'utf8');
    expect(token === staleToken).toBe(false);
    expect(oldVerify(staleToken)).toBe(true);
    expect(verify(staleToken)).toBe(false);
    expect(verify(token)).toBe(true);
  } finally {
    restarted.release();
  }
});
