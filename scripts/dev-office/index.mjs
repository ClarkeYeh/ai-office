import { launcherSession, autoMergeFinal } from './auto-merge.mjs';
import { setTimeout, clearTimeout } from 'node:timers';
import { access, mkdir, mkdtemp, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

/** Reserve an OS-selected frontend port. strictPort fails closed on races. */
/** @returns {Promise<number>} */
async function freePort() {
  const server = createServer();
  server.listen(0, 'localhost');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP port');
  const port = address.port;
  await new Promise((done) => server.close(done));
  return port === 4319 ? freePort() : port;
}

/** @param {string[]} args */
export function parseOptions(args) {
  let fake = 'demo';
  let autoMergeFinalSeconds;
  let open = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') continue;
    if (args[i] === '--open') open = true;
    else if (args[i] === '--auto-merge-final')
      autoMergeFinalSeconds = Number(args[++i] ?? NaN);
    else if (args[i] === '--fake') fake = args[++i] ?? '';
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  if (
    !['mainline', 'demo', 'parallel', 'trouble', 'load-10', 'stall'].includes(
      fake,
    )
  )
    throw new Error('Unknown fake scenario');
  autoMergeFinalSeconds ??= fake === 'demo' ? 8 : 0;
  if (!Number.isFinite(autoMergeFinalSeconds) || autoMergeFinalSeconds < 0)
    throw new Error('Invalid final merge delay');
  return { fake, open, autoMergeFinalSeconds };
}

/** @param {string[]} args */
export async function devOffice(args) {
  const { fake, open, autoMergeFinalSeconds } = parseOptions(args);
  const root = resolve(import.meta.dirname, '../..');
  for (const file of ['apps/server/dist/main.js', 'apps/cli/dist/main.js']) {
    try {
      await access(join(root, file));
    } catch {
      throw new Error(`Missing ${file}; run pnpm -r build first.`);
    }
  }
  const homeRoot = join(root, '.dev-home');
  await mkdir(homeRoot, { recursive: true });
  // Unique per invocation so concurrent workers never share a lock or database.
  const home = await mkdtemp(join(homeRoot, `${fake}-`));
  if (fake !== 'mainline') {
    await mkdir(join(home, 'templates'), { recursive: true });
    await copyFile(
      join(root, 'fixtures/web/templates', fake + '.yaml'),
      join(home, 'templates', fake + '.yaml'),
    );
  }
  const autoMergeAbort = new globalThis.AbortController();
  if (fake === 'load-10')
    await writeFile(join(home, 'config.toml'), '[limits]\nglobalAgents = 12\n');
  const vitePort = await freePort();
  const origin = `http://localhost:${vitePort}`;
  const backend = spawn(
    process.execPath,
    [
      join(root, 'apps/server/dist/main.js'),
      '--dev',
      '--fake',
      fake,
      '--port',
      '0',
      '--dev-origin',
      origin,
      '--cli-path',
      join(root, 'apps/cli/dist/main.js'),
    ],
    {
      cwd: root,
      env: { ...process.env, AI_OFFICE_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let vite;
  let stopping = false;
  let failure = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let force;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    autoMergeAbort.abort();
    vite?.kill('SIGTERM');
    backend.kill('SIGTERM');
    force = setTimeout(() => {
      vite?.kill('SIGKILL');
      backend.kill('SIGKILL');
    }, 5000);
    force.unref();
  };
  const fail = (/** @type {Error} */ error) => {
    failure = true;
    console.error(error.message);
    stop();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  backend.on('error', fail);
  backend.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const backendDone = new Promise((resolve) => backend.once('close', resolve));
  /** @type {Promise<unknown> | undefined} */
  let viteDone;
  const timeout = setTimeout(
    () => fail(new Error('Backend bootstrap timed out.')),
    60_000,
  );
  const lines = createInterface({ input: backend.stdout });
  lines.on('line', (line) => {
    const match =
      /^Open (http:\/\/127\.0\.0\.1:(\d+)\/auth\/bootstrap\?code=\S+)$/.exec(
        line,
      );
    if (!match) return; // Never echo backend bootstrap credentials at the wrong origin.
    if (stopping || vite) return;
    clearTimeout(timeout);
    const port = match[2];
    if (port === '4319') {
      fail(new Error('Refusing reserved backend port 4319; retry.'));
      return;
    }
    if (autoMergeFinalSeconds > 0) {
      const url = 'http://127.0.0.1:' + port;
      void launcherSession(home, url)
        .then((cookie) =>
          autoMergeFinal(
            url,
            cookie,
            autoMergeFinalSeconds,
            autoMergeAbort.signal,
          ),
        )
        .catch((error) => {
          if (!stopping) fail(error);
        });
    }
    const bootstrap = new URL(/** @type {string} */ (match[1]));
    const login = origin + bootstrap.pathname + bootstrap.search;
    const viteBin = join(root, 'apps/web/node_modules/vite/bin/vite.js');
    vite = spawn(
      process.execPath,
      [
        viteBin,
        '--host',
        'localhost',
        '--port',
        String(vitePort),
        '--strictPort',
        ...(open ? ['--open', login] : []),
      ],
      {
        cwd: join(root, 'apps/web'),
        env: { ...process.env, AI_OFFICE_PORT: port },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    viteDone = new Promise((resolve) => vite?.once('close', resolve));
    vite.on('error', fail);
    vite.once('exit', (code) => {
      if (!stopping) {
        failure = code !== 0;
        stop();
      }
    });
    vite.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    let announced = false;
    vite.stdout?.on('data', (chunk) => {
      process.stdout.write(chunk);
      if (!announced && String(chunk).includes('Local:')) {
        announced = true;
        console.log(
          `AI_OFFICE_HOME=${home}\nBackend port=${port}\nOpen ${login}`,
        );
      }
    });
  });
  try {
    const code = await backendDone;
    if (!stopping) failure = code !== 0;
    stop();
    await viteDone;
    if (failure) process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    clearTimeout(force);
    lines.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  devOffice(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
