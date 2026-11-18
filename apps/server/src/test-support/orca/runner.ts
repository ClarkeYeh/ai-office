import { readFile, readdir, mkdtemp } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { HarnessExec, OrcaHarness, type HarnessOptions } from './harness.js';
import { leftovers, loadLedger } from './ledger.js';
import { Normalizer, RecordingExec, type Recording } from './recording.js';
import {
  P2_CONFIRMATION,
  requireInteractiveConfirmation,
  resumeP2,
} from './p2.js';

interface Scenario {
  run(harness: OrcaHarness): Promise<void>;
  prepare?(
    harness: OrcaHarness,
    confirmation: { stdinTTY: boolean; stdoutTTY: boolean; answer: string },
  ): Promise<string>;
  verify?(
    harness: OrcaHarness,
    state: Awaited<ReturnType<typeof resumeP2>>,
  ): Promise<void>;
}
/** Entry points intentionally never restart Orca, modify settings, or register repositories. */
export async function runHarnessCli(
  argv: string[],
  env = process.env,
): Promise<void> {
  const [action, scenarioName] = argv;
  const option = (name: string) => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv[i + 1];
  };
  const sourceRoot = resolve(import.meta.dirname, '../../../../..');
  if (action === 'normalize') {
    const file = scenarioName;
    if (!file) throw new Error('Input recording required');
    process.stdout.write(
      JSON.stringify(
        new Normalizer().value(JSON.parse(await readFile(file, 'utf8'))),
        null,
        2,
      ) + '\n',
    );
    return;
  }
  if (
    env.CI ||
    env.AIO_REAL_ORCA !== '1' ||
    !env.AIO_TEST_REPO_PATH ||
    !env.AIO_ORCA_BIN
  )
    throw new Error(
      'Requires AIO_REAL_ORCA=1, AIO_TEST_REPO_PATH and absolute AIO_ORCA_BIN outside CI',
    );
  if (
    action === 'p2' &&
    scenarioName === 'prepare' &&
    (!process.stdin.isTTY || !process.stdout.isTTY)
  )
    throw new Error('P2 prepare requires interactive TTY');
  const exec = new HarnessExec();
  const cwd = await mkdtemp(join(tmpdir(), 'aio-test-discovery-'));
  const options: HarnessOptions = {
    repoPath: env.AIO_TEST_REPO_PATH,
    ...(env.AIO_TEST_REPO_URL ? { repoUrl: env.AIO_TEST_REPO_URL } : {}),
    sourceRoot,
    orcaBin: env.AIO_ORCA_BIN,
    env,
    agents: env.AIO_REAL_AGENTS === '1',
    exec,
    worktreePaths: async () => {
      // Fresh os.tmpdir directory avoids Orca's caller inference during inventory bootstrap.
      const result = await exec.run({
        bin: env.AIO_ORCA_BIN!,
        args: ['worktree', 'list', '--json'],
        cwd,
        env,
        timeoutMs: 30_000,
      });
      const parsed = JSON.parse(result.stdout) as {
        ok?: boolean;
        result?: { worktrees?: { path?: string }[] };
      };
      if (!parsed.ok || !Array.isArray(parsed.result?.worktrees))
        throw new Error('Cannot establish Orca worktree inventory');
      return parsed.result.worktrees.map((w) => {
        if (!w.path) throw new Error('Missing worktree path');
        return w.path;
      });
    },
  };
  if (
    action === 'janitor' &&
    (argv.includes('--scan') || scenarioName === 'scan')
  ) {
    if (argv.includes('--apply'))
      throw new Error('Scan is read-only; use an owned ledger for --apply');
    const harness = await OrcaHarness.create(options);
    const found = await harness.scan();
    // Only selected test resources are shown; unrelated inventory never leaves memory.
    for (const item of found) console.info(JSON.stringify(item));
    console.info(`Remaining resources (scan): ${found.length}`);
    return;
  }
  if (action === 'janitor') {
    const file = option('--ledger');
    if (!file) throw new Error('Janitor requires --ledger <resources.json>');
    const ledger = await loadLedger(file);
    const pending = leftovers(ledger);
    // Print counts only; paths and handles stay in the private ledger.
    console.info(`Remaining resources: ${pending.length}`);
    if (argv.includes('--apply')) {
      const harness = await OrcaHarness.create({ ...options, ledger });
      await harness.clean();
      console.info(`Remaining resources: ${leftovers(harness.ledger).length}`);
    }
    return;
  }
  if (action === 'recheck') {
    const previous = option('--previous');
    const current = option('--current');
    if (!previous || !current)
      throw new Error(
        'Recheck requires --previous and --current recording directories',
      );
    const shape = (value: unknown): unknown => {
      if (Array.isArray(value))
        return [...new Set(value.map((v) => JSON.stringify(shape(v))))].sort();
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value)
            .sort()
            .map(([k, v]) => [k, shape(v)]),
        );
      return value === null ? 'null' : typeof value;
    };
    const files = (await readdir(previous)).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const a = JSON.parse(await readFile(join(previous, file), 'utf8')) as
        Recording | Recording[];
      const b = JSON.parse(await readFile(join(current, file), 'utf8')) as
        Recording | Recording[];
      if (
        JSON.stringify(
          shape(Array.isArray(a) ? a.map((r) => r.response) : a.response),
        ) !==
        JSON.stringify(
          shape(Array.isArray(b) ? b.map((r) => r.response) : b.response),
        )
      )
        throw new Error('Recording structure changed; adapter review required');
    }
    console.info(
      'Recording structures match; run contract replay and CLI-only tests before changing supportedRange.',
    );
    return;
  }
  const modulePath = option('--scenario');
  let scenario: Scenario;
  if (modulePath)
    scenario = (await import(
      pathToFileURL(resolve(modulePath)).href
    )) as Scenario;
  else if (scenarioName === 'smoke')
    scenario = {
      run: async (harness) => {
        const sha = env.AIO_TEST_BASE_SHA;
        if (!sha) throw new Error('Smoke requires AIO_TEST_BASE_SHA');
        const shim = await harness.createShim(
          join(env.HOME ?? '', '.ai-office', 'orca-home'),
        );
        const suffix = basename(harness.ledger.dataDir);
        await harness.createRun(shim, suffix);
        await harness.createWorktree(suffix, `ai-office-test/${suffix}`, sha);
      },
    };
  else
    throw new Error('Provide smoke or --scenario <compiled scenario module>');
  const recording = new RecordingExec(
    exec,
    env.AIO_ORCA_VERSION ?? 'unverified',
  );
  let ledger;
  let state;
  if (action === 'p2' && scenarioName === 'verify') {
    const path = option('--resume');
    if (!path) throw new Error('P2 verify requires --resume');
    state = await resumeP2(path);
    ledger = await loadLedger(join(state.ledger.dataDir, 'resources.json'));
  }
  const harness = await OrcaHarness.create({
    ...options,
    exec: recording,
    ...(ledger ? { ledger } : {}),
  });
  const status = await harness.command(['status', '--json']);
  const version = (status.runtime as { appVersion?: unknown } | undefined)
    ?.appVersion;
  if (typeof version !== 'string') throw new Error('Orca version unavailable');
  recording.setVersion(version);
  if (action === 'p2' && scenarioName === 'prepare') {
    if (!scenario.prepare)
      throw new Error('Scenario does not implement P2 prepare');
    const reader = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let answer: string;
    try {
      answer = await reader.question(`Type exactly: ${P2_CONFIRMATION}\n> `);
    } finally {
      reader.close();
    }
    const confirmation = {
      stdinTTY: !!process.stdin.isTTY,
      stdoutTTY: !!process.stdout.isTTY,
      answer,
    };
    requireInteractiveConfirmation(confirmation);
    // CLI reports update capability, not whether an update is staged: the typed
    // confirmation includes the owner's UI check and coordinator's worker check.
    await harness.command(['status', '--json']);
    try {
      const statePath = await scenario.prepare(harness, confirmation);
      const prepared = await resumeP2(statePath);
      if (
        prepared.version !== version ||
        prepared.ledger.dataDir !== harness.ledger.dataDir
      )
        throw new Error('P2 scenario did not persist current observations');
    } catch (error) {
      await harness.clean();
      throw error;
    }
    console.info(
      'Prepared. The owner may now restart Orca; this tool never performs the restart.',
    );
    return;
  }
  let finish: (() => Promise<void>) | undefined;
  harness.installCleanup((fn) => {
    finish = fn;
  });
  try {
    if (action === 'p2') {
      if (!state || !scenario.verify)
        throw new Error('Scenario does not implement P2 verify');
      await scenario.verify(harness, state);
    } else if (action === 'record') await scenario.run(harness);
    else throw new Error('Unknown harness command');
  } finally {
    try {
      await finish?.();
      if (scenarioName === 'smoke') await harness.assertClean();
    } finally {
      await recording.save(
        join(harness.ledger.dataDir, `recording-${Date.now()}.json`),
      );
      console.info(`Private harness artifacts: ${harness.ledger.dataDir}`);
    }
  }
}
