import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { ProcessGroups, SpawnExec } from './process.js';

function fixture(maxBytes = 1024) {
  let saved: unknown = null;
  const groups = new ProcessGroups({
    read: () => saved,
    write: (_scope, value) => {
      saved = structuredClone(value);
    },
  });
  const events = new EventEmitter();
  const child = Object.assign(events, {
    pid: 123,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams;
  const spawn = vi.fn(() => child);
  const kill = vi.fn();
  const exec = new SpawnExec(groups, spawn, kill, maxBytes);
  const request = {
    bin: '/bin/orca',
    args: ['status', '--json'],
    cwd: '/tmp/cli-cwd',
    env: { HOME: '/tmp/home' },
    timeoutMs: 30_000,
  };
  return { child, spawn, kill, exec, request, saved: () => saved };
}
afterEach(() => {
  vi.useRealTimers();
});
it('spawns a detached non-shell process and parses only stdout despite stderr keepalives', async () => {
  const f = fixture();
  const result = f.exec.run(f.request);
  f.child.emit('spawn');
  expect(f.saved()).toEqual([{ pgid: 123, digest: expect.any(String) }]);
  f.child.stderr.write('keepalive: still waiting\n');
  f.child.stdout.write('{"ok":true,"result":{}}');
  f.child.emit('close', 1);
  expect(await result).toEqual({
    stdout: '{"ok":true,"result":{}}',
    exitCode: 1,
  });
  expect(f.spawn).toHaveBeenCalledWith('/bin/orca', ['status', '--json'], {
    cwd: '/tmp/cli-cwd',
    env: { HOME: '/tmp/home' },
    detached: true,
    shell: false,
  });
  expect(f.saved()).toEqual([]);
});
it('terminates the entire process group on timeout, then escalates to SIGKILL', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const result = f.exec.run(f.request);
  const rejected = expect(result).rejects.toMatchObject({
    category: 'transient',
    code: 'ETIMEDOUT',
  });
  f.child.emit('spawn');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.kill).toHaveBeenCalledWith(123, 'SIGTERM');
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.kill).toHaveBeenCalledWith(123, 'SIGKILL');
  f.child.emit('close', null);
  await rejected;
});
it('rejects aborted and oversized subprocesses without retaining output in errors', async () => {
  const f = fixture(4);
  const result = f.exec.run(f.request);
  f.child.stdout.write('private-output');
  f.child.emit('close', null);
  await expect(result).rejects.toMatchObject({
    category: 'guard',
    code: 'cli_output_limit',
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.exec.run({ ...f.request, signal: controller.signal }),
  ).rejects.toMatchObject({ code: 'cli_aborted' });
  expect(f.spawn).toHaveBeenCalledOnce();
});
it('reports spawn failure without leaking the system error text', async () => {
  const f = fixture();
  const result = f.exec.run(f.request);
  f.child.emit('error', new Error('private system output'));
  f.child.emit('close', -2);
  await expect(result).rejects.toMatchObject({
    code: 'runtime_unavailable',
    message: 'Orca command failed',
  });
});
