/**
 * M5-T7 backend launchers for the two harness modes (M5_PLAN §2.1, §2.5):
 * - `production` (T12): the real `ai-office start` (production-cli.ts) on an
 *   isolated home with a fixed port in its `config.toml`;
 * - `preview` (T11b): the dev child (`--dev --runtime orca`) with the
 *   scm-gitremote stand-in bridged from the harness process.
 * Both return a `ControlledBackend` for the restart control (same home and
 * port on every start) and never touch `~/.ai-office` or port 4319.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import type { ComposedEffects } from '../orca/harness.js';
import { runProductionCli } from '../orca/production-cli.js';
import { startBackendProcess } from '../orca/t17/backend-process.js';
import type { ScmPort } from '../../ports/scm.js';
import {
  productionConfig,
  type ProductionConfig,
} from '../github/production-smoke.js';
import type { ControlledBackend } from './restart.js';
import { serveScm } from './scm-bridge.js';

/** The owner's own instance port; a joint run never uses it. */
export const OWNER_PORT = 4319;

/** Built preview child; the minimal environment cannot run TypeScript sources. */
export const JOINT_CHILD_ENTRY = resolve(
  import.meta.dirname,
  '../../../dist/test-support/joint/backend-child.js',
);

/** A free loopback port (never 4319), fixed for the whole run. */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((done, fail) => {
      const server = createServer();
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() =>
          done(typeof address === 'object' && address ? address.port : 0),
        );
      });
    });
    if (port > 0 && port !== OWNER_PORT) return port;
  }
}

/** Refuses the owner's home or port before anything is written. */
export function assertIsolated(home: string, port: number): void {
  const owner = process.env.HOME ? join(process.env.HOME, '.ai-office') : '';
  if (owner && (resolve(home) === owner || resolve(home) === `${owner}/`))
    throw new Error("Joint runs never use the owner's ~/.ai-office");
  if (port === OWNER_PORT) throw new Error('Joint runs never use port 4319');
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535)
    throw new Error('A fixed port is required');
}

/** `[server] port` pinned in an existing config.toml (same port on restart). */
export async function pinPort(home: string, port: number): Promise<void> {
  assertIsolated(home, port);
  await appendFile(join(home, 'config.toml'), `[server]\nport = ${port}\n`);
}

/** Template overrides (T8's integrator-scope fallback) beside the built-ins. */
export async function writeTemplates(
  home: string,
  templates: Record<string, string>,
): Promise<void> {
  await mkdir(join(home, 'templates'), { recursive: true, mode: 0o700 });
  for (const [file, yaml] of Object.entries(templates))
    await writeFile(join(home, 'templates', file), yaml, { mode: 0o600 });
}

/** Isolated production home: config (absolute binaries, fixed port), templates. */
export async function productionHome(options: {
  home: string;
  port: number;
  config: ProductionConfig;
  templates: Record<string, string>;
}): Promise<void> {
  assertIsolated(options.home, options.port);
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  await writeFile(
    join(options.home, 'config.toml'),
    productionConfig({ ...options.config, enforcement: 'off' }),
    { mode: 0o600 },
  );
  await pinPort(options.home, options.port);
  await writeTemplates(options.home, options.templates);
}

/** `ai-office start` on the fixed port. */
export function productionLauncher(options: {
  home: string;
  port: number;
}): () => Promise<ControlledBackend> {
  return async () => {
    const result = await runProductionCli({
      home: options.home,
      port: options.port,
    });
    if (result.kind !== 'ready')
      throw new Error(`production start exited ${result.exitCode}`);
    return {
      pid: result.serverPid,
      url: result.url,
      bootstrapUrl: result.bootstrapUrl,
      // The CLI shell exits right after its server child dies.
      exited: result.exited,
      stop: () => result.stop(),
    };
  };
}

/**
 * The preview child on the fixed port. Only the first start may create (and
 * ledger) the shim; a restart that creates another one fails (#12).
 */
export function previewLauncher(options: {
  home: string;
  port: number;
  orcaHome: string;
  scm: ScmPort;
  effects: ComposedEffects;
}): () => Promise<ControlledBackend> {
  let starts = 0;
  const relay = serveScm(options.scm);
  return async () => {
    starts++;
    const backend = await startBackendProcess({
      home: options.home,
      orcaHome: options.orcaHome,
      ...(starts === 1 ? { effects: options.effects } : {}),
      logName: `backend-${starts}.log`,
      entry: JOINT_CHILD_ENTRY,
      env: { AIO_JOINT_PORT: String(options.port) },
      onMessage: relay,
      serialization: 'advanced',
    });
    return {
      pid: backend.pid,
      url: backend.url,
      bootstrapUrl: backend.bootstrapUrl,
      exited: backend.exited,
      stop: () => backend.stop(),
    };
  };
}
