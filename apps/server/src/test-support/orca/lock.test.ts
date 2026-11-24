import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acquireOrcaLiveLock } from './lock.js';

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-orca-lock-'));
  path = join(dir, 'test-state', 'orca-live.lock');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
const seed = async (value: string) => {
  await mkdir(join(dir, 'test-state'), { recursive: true });
  await writeFile(path, value);
};
it('excludes another holder and releases only its own private lock', async () => {
  const release = await acquireOrcaLiveLock(path);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(dir, 'test-state'))).mode & 0o777).toBe(0o700);
  await expect(acquireOrcaLiveLock(path)).rejects.toThrow('held');
  await release();
  await (
    await acquireOrcaLiveLock(path)
  )();
});
it.each([
  '{',
  'null',
  '{}',
  '{"pid":0}',
  '{"pid":-1}',
  '{"pid":"1"}',
  '{"pid":1.5}',
])('refuses malformed lock %s', async (value) => {
  await seed(value);
  await expect(acquireOrcaLiveLock(path)).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe(value);
});
it('reclaims only an ESRCH pid and serializes stale reclaimers', async () => {
  await seed('{"pid":123}');
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error(), { code: 'ESRCH' });
  });
  await writeFile(path + '.reclaim', '');
  await expect(acquireOrcaLiveLock(path)).rejects.toThrow(
    'reclamation in progress',
  );
  await rm(path + '.reclaim');
  const release = await acquireOrcaLiveLock(path);
  expect(JSON.parse(await readFile(path, 'utf8')).pid).toBe(process.pid);
  await release();
});
it('fails closed on permission-denied pid probes', async () => {
  await seed('{"pid":123}');
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error(), { code: 'EPERM' });
  });
  await expect(acquireOrcaLiveLock(path)).rejects.toThrow('held');
});
it('does not unlink a replacement lock on release', async () => {
  const release = await acquireOrcaLiveLock(path);
  await writeFile(path, '{"pid":456}');
  await expect(release()).rejects.toThrow('ownership changed');
  expect(await readFile(path, 'utf8')).toBe('{"pid":456}');
});
it('fails if the lock parent cannot be created', async () => {
  await writeFile(join(dir, 'file'), '');
  await expect(
    acquireOrcaLiveLock(join(dir, 'file', 'lock')),
  ).rejects.toThrow();
});

it('acquires before commands, releases failed startup, and retains ownership until close', async () => {
  const { OrcaHarness } = await import('./harness.js');
  const home = dir;
  const lock = join(home, '.ai-office', 'test-state', 'orca-live.lock');
  const run = vi.fn(async () => {
    throw new Error('synthetic verify failure');
  });
  const options = {
    repoPath: dir,
    sourceRoot: process.cwd(),
    orcaBin: '/synthetic/orca',
    worktreePaths: async () => [],
    env: { HOME: home, AIO_REAL_ORCA: '1' },
    exec: { run },
  };
  const release = await acquireOrcaLiveLock(lock);
  await expect(OrcaHarness.create(options)).rejects.toThrow('held');
  expect(run).not.toHaveBeenCalled();
  await release();
  await expect(OrcaHarness.create(options)).rejects.toThrow(
    'synthetic verify failure',
  );
  const releaseAgain = await acquireOrcaLiveLock(lock);
  await releaseAgain();
  const harness = await OrcaHarness.create({
    ...options,
    exec: {
      run: async () => ({
        exitCode: 0,
        stdout: 'https://github.com/ClarkeYeh/ai-office-spike.git',
      }),
    },
  });
  harness.ledger.pending.push({ id: 'pending', kind: 'synthetic' });
  await expect(harness.clean()).rejects.toThrow('Unresolved mutation receipt');
  await expect(acquireOrcaLiveLock(lock)).rejects.toThrow('held');
  await harness.close();
  await harness.close();
  await (
    await acquireOrcaLiveLock(lock)
  )();
  await rm(harness.ledger.dataDir, { recursive: true, force: true });
});

it('holds the suite lock through its final scan and closes after that scan', async () => {
  const { OrcaHarness } = await import('./harness.js');
  const lock = join(dir, '.ai-office', 'test-state', 'orca-live.lock');
  const harness = await OrcaHarness.create({
    repoPath: dir,
    sourceRoot: process.cwd(),
    orcaBin: '/synthetic/orca',
    worktreePaths: async () => [],
    env: { HOME: dir, AIO_REAL_ORCA: '1' },
    exec: {
      run: async () => ({
        exitCode: 0,
        stdout: 'https://github.com/ClarkeYeh/ai-office-spike.git',
      }),
    },
  });
  vi.spyOn(harness, 'clean').mockResolvedValue();
  const scan = vi.spyOn(harness, 'scan').mockImplementation(async () => {
    await expect(acquireOrcaLiveLock(lock)).rejects.toThrow('held');
    return [];
  });
  let finish: (() => Promise<void>) | undefined;
  harness.installCleanup((fn) => {
    finish = fn;
  });
  await finish!();
  expect(scan).toHaveBeenCalledOnce();
  await (
    await acquireOrcaLiveLock(lock)
  )();
  await rm(harness.ledger.dataDir, { recursive: true, force: true });
});
