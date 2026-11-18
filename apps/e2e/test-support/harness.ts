import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT } from './office.js';

const WEB = join(ROOT, 'apps/web');
export const HARNESS_CONFIG = 'vite.harness.config.ts';
const VITE = join(WEB, 'node_modules/vite/bin/vite.js');

export const harnessAvailable = () => existsSync(join(WEB, HARNESS_CONFIG));

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  await new Promise((done) => server.close(done));
  if (!address || typeof address === 'string') throw new Error('No TCP port');
  return address.port === 4319 ? freePort() : address.port;
}

/** Builds the scene harness and serves it with `vite preview` (§7.1). */
export async function startHarnessPreview(): Promise<{
  origin: string;
  stop: () => Promise<void>;
}> {
  const build = spawnSync(
    process.execPath,
    [VITE, 'build', '--config', HARNESS_CONFIG],
    { cwd: WEB, encoding: 'utf8' },
  );
  if (build.status !== 0)
    throw new Error(`Harness build failed\n${build.stdout}${build.stderr}`);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const preview = spawn(
    process.execPath,
    [
      VITE,
      'preview',
      '--config',
      HARNESS_CONFIG,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: WEB, stdio: 'ignore' },
  );
  const exited = once(preview, 'exit');
  const stop = async () => {
    if (preview.exitCode !== null || preview.signalCode !== null) return;
    preview.kill('SIGTERM');
    await exited;
  };
  for (const deadline = Date.now() + 30_000; ;) {
    try {
      if ((await fetch(origin)).ok) return { origin, stop };
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline || preview.exitCode !== null) {
      await stop();
      throw new Error('Harness preview did not start');
    }
    await delay(200);
  }
}
