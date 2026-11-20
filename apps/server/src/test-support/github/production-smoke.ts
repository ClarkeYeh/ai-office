/**
 * M3-T16 production startup acceptance and refusal matrix (M3_PLAN §6), plus
 * the T17 preparation it shares: an isolated AI_OFFICE_HOME, the owner-approved
 * `~/.ai-office/orca-home` (S11; never registered here) and `ai-office start`
 * without `--dev`. Production makes GitHub reads only (GA level): nothing is
 * created on the spike, so the T7 ledger stays empty and the independent scan
 * plus a before/after inventory prove it. Orca effects (the shim) go through
 * the M2 harness ledger by the backend's `aio-shim:<hash>` marker. The active
 * account is never switched: its mismatch is an injected probe in process.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { vi } from 'vitest';
import * as githubConfig from '../../config/read-gh-token.js';
import { parseArgs, startServer, type RunningServer } from '../../main.js';
import type { OrcaHarness } from '../orca/harness.js';
import { runProductionCli } from '../orca/production-cli.js';
import {
  decide,
  drive,
  gates,
  session,
  type Api,
  type DriveRecord,
  type Json,
} from '../orca/t17/office.js';
import type { GithubApi } from './api.js';
import { withHarness } from './harness.js';
import { git } from './process.js';
import { API, REPO, ROOT } from './safety.js';

export const OWNER = 'ClarkeYeh';

/** The only Orca folder AI Office may use here (S11); registered by the owner. */
export function approvedOrcaHome(home = process.env.HOME): string {
  if (!home || !isAbsolute(home)) throw new Error('Absolute HOME required');
  return join(home, '.ai-office', 'orca-home');
}

/** An absolute executable: explicit override first, then the caller's PATH. */
export async function resolveBinary(
  name: string,
  override: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const candidates = override
    ? [override]
    : (env.PATH ?? '')
        .split(delimiter)
        .filter((dir) => isAbsolute(dir))
        .map((dir) => join(dir, name));
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Next candidate. */
    }
  }
  throw new Error(`Absolute ${name} executable required`);
}

export interface ProductionConfig {
  orcaBin: string;
  ghBin: string;
  orcaHome: string;
  expectedLogin: string;
  /** T17 runs with enforcement off (no token caps, M2 Q3). */
  enforcement?: 'on' | 'off';
}

/** config.toml for an isolated production home; absolute binaries for the GUI PATH. */
export function productionConfig(config: ProductionConfig): string {
  for (const path of [config.orcaBin, config.ghBin, config.orcaHome])
    if (!isAbsolute(path)) throw new Error('Absolute paths required');
  return [
    '[orca]',
    `bin = ${JSON.stringify(config.orcaBin)}`,
    `homeDir = ${JSON.stringify(config.orcaHome)}`,
    // The integrator wraps live runs in `caffeinate -i`.
    'preventSleep = false',
    '[budget]',
    `enforcement = ${JSON.stringify(config.enforcement ?? 'on')}`,
    '[github]',
    `ghBin = ${JSON.stringify(config.ghBin)}`,
    `expectedLogin = ${JSON.stringify(config.expectedLogin)}`,
    '',
  ].join('\n');
}

/** Health a fresh production start must publish (M3_PLAN §6 T16 item 1). */
export function healthFailures(health: Json, orcaHome: string): string[] {
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => ok || failures.push(what);
  check(health?.runtime?.mode === 'orca', 'runtime mode orca');
  check(health?.runtime?.shim?.status === 'ok', 'shim ready');
  check(
    health?.runtime?.shim?.location === orcaHome,
    'shim in the approved orca-home',
  );
  check(health?.scm?.status === 'healthy', 'scm healthy');
  check(health?.scm?.login === OWNER, 'scm login is the owner');
  check(health?.scm?.tokenSource === 'gh', 'tokenSource gh');
  check(
    Number.isSafeInteger(health?.scm?.rateLimit?.remaining) &&
      health.scm.rateLimit.remaining > 0,
    'rate limit published',
  );
  check(
    !(health?.scm?.warnings ?? []).includes('expected_login_unset'),
    'expectedLogin pinned',
  );
  return failures;
}

/** The spike's registration snapshot (S4: ruleset → protected; 0 approvals). */
export function registrationFailures(repo: Json | undefined): string[] {
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => ok || failures.push(what);
  check(repo?.status === 'registered', 'repo registered');
  check(
    `${repo?.github?.owner}/${repo?.github?.name}` === REPO,
    'repo is the spike',
  );
  check(repo?.ownerLogin === OWNER, 'ownerLogin is the owner');
  check(repo?.defaultBranch === 'main', 'default branch main');
  check(repo?.visibility === 'public', 'visibility public');
  check(repo?.defaultBranchProtected === true, 'defaultBranchProtected true');
  check(repo?.allowMergeCommit === true, 'allowMergeCommit true');
  check(
    Array.isArray(repo?.warnings) && repo.warnings.length === 0,
    `no registration warnings (${JSON.stringify(repo?.warnings)})`,
  );
  return failures;
}

/** Read-only: open Issues/PRs and every `ai-office/` branch on the spike. */
export async function spikeInventory(api: GithubApi) {
  const open = (await api.list('/issues?state=open'))
    .map((o) => Number(o.number))
    .sort((a, b) => a - b);
  const branches = (await api.list('/git/matching-refs/heads/ai-office/'))
    .map((b) => String(b.ref))
    .sort();
  return { open, branches };
}

/** Ledgers every shim carrying this backend's marker; returns how many exist. */
export async function ledgerShims(
  h: OrcaHarness,
  effects: { marker: string; shim(handle: string): Promise<void> },
): Promise<number> {
  const shims = (await h.scan()).filter(
    (r) => r.kind === 'shim' && r.name.endsWith(` ${effects.marker}`),
  );
  for (const shim of shims) await effects.shim(shim.id);
  return shims.length;
}

/** Credentials the backend must never inherit from this test process. */
const AMBIENT_TOKENS = [
  'AI_OFFICE_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

/**
 * Fails closed before the network on any GitHub request the production
 * backend may not make in T16: every call must be a GET on the account
 * endpoints or the spike. Local (127.0.0.1) calls pass through.
 */
export function guardGithubReads(original: typeof fetch = globalThis.fetch) {
  const calls: string[] = [];
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== API) return original(input, init);
      const path = url.pathname;
      calls.push(`${request.method} ${path}`);
      if (
        request.method !== 'GET' ||
        !(
          path === '/user' ||
          path === '/rate_limit' ||
          path === ROOT ||
          path.startsWith(ROOT + '/')
        )
      )
        throw new Error('T16 production made a non-read GitHub request');
      return original(input, init);
    });
  return { calls, restore: () => spy.mockRestore() };
}

/**
 * In-process production start (no `--dev`) whose active-account probe is
 * injected: `readActiveGhLogin` returns `login` without reading any token.
 * The backend token is still the real `--user` credential.
 */
export async function startWithActiveLogin(
  home: string,
  login: string,
): Promise<RunningServer> {
  const env: NodeJS.ProcessEnv = { ...process.env, AI_OFFICE_HOME: home };
  for (const name of AMBIENT_TOKENS) delete env[name];
  const probe = vi
    .spyOn(githubConfig, 'readActiveGhLogin')
    .mockResolvedValue(login);
  try {
    return await startServer({
      port: 0,
      env,
      webDist: join(home, 'no-web'),
      print: () => undefined,
    });
  } finally {
    probe.mockRestore();
  }
}

/** True when a refused start left no lock holder behind. */
export const released = (home: string) =>
  !existsSync(join(home, 'runtime.json')) &&
  !existsSync(join(home, 'data', '.lock'));

type Step = { name: string; ok: boolean; ms: number; detail?: string };

/** Runner scenario (`pnpm test:github:e2e`); the runner asserts Orca ledger 0 / scan 0. */
export const assertClean = true;

export async function run(h: OrcaHarness): Promise<void> {
  const orcaBin = await resolveBinary('orca', process.env.AIO_ORCA_BIN);
  const ghBin = await resolveBinary('gh', process.env.AIO_GH_BIN);
  const orcaHome = approvedOrcaHome();
  const home = join(h.ledger.dataDir, 'production');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const configPath = join(home, 'config.toml');
  const writeConfig = (expectedLogin: string) =>
    writeFile(
      configPath,
      productionConfig({ orcaBin, ghBin, orcaHome, expectedLogin }),
      { mode: 0o600 },
    );
  await writeConfig(OWNER);
  const steps: Step[] = [];
  // Every start may create or adopt the shim: ledger it even if the step fails.
  let afterStart = async (): Promise<unknown> => undefined;
  const step = async (
    name: string,
    body: () => Promise<string[]>,
    starts = true,
  ) => {
    const started = Date.now();
    let failures: string[];
    try {
      failures = await body();
    } catch (error) {
      failures = [
        `threw ${error instanceof Error ? error.constructor.name + ': ' + error.message : 'unknown'}`,
      ];
    }
    if (starts)
      await afterStart().catch(() => failures.push('shim ledgering failed'));
    steps.push({
      name,
      ok: failures.length === 0,
      ms: Date.now() - started,
      ...(failures.length ? { detail: failures.join('; ') } : {}),
    });
  };

  const report = await withHarness(async (github) => {
    const before = await spikeInventory(github.api);
    const effects = await h.composedBackend(home);
    let settled = false;
    const ledger = async () => {
      const count = await ledgerShims(h, effects);
      if (count && !settled) {
        await effects.settle();
        settled = true;
      }
      return count;
    };
    afterStart = ledger;
    const rate: { start?: number; end?: number } = {};

    // Refusal matrix first: a registered spike would turn the unknown-login
    // case into an owner mismatch instead of "that account is not logged in".
    await step(
      'refuse --fake without --dev (CLI)',
      async () => {
        const result = await runProductionCli({
          home,
          args: ['--fake', 'mainline'],
        });
        return result.kind === 'exited' &&
          result.exitCode === 1 &&
          result.lines.some((l) => l.includes('requires --dev')) &&
          !existsSync(join(home, 'data'))
          ? []
          : ['CLI did not refuse --fake before starting'];
      },
      false,
    );
    await step(
      'refuse --fake without --dev (server)',
      async () => {
        const refused = await startServer({
          ...parseArgs(['--fake', 'mainline']),
          env: { HOME: process.env.HOME, AI_OFFICE_HOME: home },
          print: () => undefined,
        }).then(
          async (server) => {
            await server.close();
            return undefined;
          },
          (error: unknown) => error,
        );
        return refused instanceof Error &&
          /require --dev/.test(refused.message) &&
          !existsSync(join(home, 'data'))
          ? []
          : ['server did not refuse --fake before side effects'];
      },
      false,
    );
    await step('refuse an invalid AI_OFFICE_GITHUB_TOKEN', async () => {
      const result = await runProductionCli({
        home,
        // Synthetic, not token-shaped: GitHub answers 401 Bad credentials.
        env: { AI_OFFICE_GITHUB_TOKEN: 'aio-t16-invalid-credential' },
      });
      if (result.kind === 'ready') {
        await result.stop();
        return ['started with an invalid token'];
      }
      return result.exitCode === 1 && released(home)
        ? []
        : [`exit ${result.exitCode}, released ${released(home)}`];
    });
    await step('refuse an expectedLogin that is not logged in', async () => {
      // Random and never a real account on this machine; gh refuses --user.
      const unknown = `aio-t16-nobody-${randomBytes(4).toString('hex')}`;
      await writeConfig(unknown);
      try {
        const result = await runProductionCli({ home });
        if (result.kind === 'ready') {
          await result.stop();
          return ['started with an unknown expectedLogin'];
        }
        return result.exitCode === 1 &&
          result.lines.some((l) =>
            l.includes(`gh auth login for ${unknown}`),
          ) &&
          released(home)
          ? []
          : [`exit ${result.exitCode}, released ${released(home)}`];
      } finally {
        await writeConfig(OWNER);
      }
    });
    await step(
      'refuse an active-account mismatch (injected probe)',
      async () => {
        const guard = guardGithubReads();
        try {
          const refused = await startWithActiveLogin(
            home,
            'aio-t16-not-owner',
          ).then(
            async (server) => {
              await server.close();
              return undefined;
            },
            (error: unknown) => error,
          );
          const failures: string[] = [];
          const code = (refused as { code?: unknown } | undefined)?.code;
          const status = (refused as { status?: unknown } | undefined)?.status;
          if (code !== 'scm_login_mismatch' || status !== 409)
            failures.push(
              `expected 409 scm_login_mismatch, got ${String(code)}`,
            );
          if (!released(home)) failures.push('lock not released');
          // The real backend identity was verified before the injected probe.
          if (!guard.calls.includes('GET /user'))
            failures.push('backend identity not checked');
          return failures;
        } finally {
          guard.restore();
        }
      },
    );

    // Production startup acceptance (`ai-office start`, GUI-like environment).
    let repoId: string | undefined;
    await step('production start, health and spike registration', async () => {
      const result = await runProductionCli({ home });
      if (result.kind !== 'ready')
        return [`exited ${result.exitCode}: ${result.lines.join(' | ')}`];
      const failures: string[] = [];
      try {
        if (!result.banner.includes(`(runtime: orca, scm: github ${OWNER})`))
          failures.push('banner names runtime orca and scm github owner');
        const api = await session(result.url, result.bootstrapUrl);
        const health = (await api.call('GET', '/api/v1/health')).body;
        failures.push(...healthFailures(health, orcaHome));
        rate.start = health?.scm?.rateLimit?.remaining;
        const registered = await api.call('POST', '/api/v1/repos', {
          localPath: h.ledger.repoPath,
        });
        if (registered.status !== 201)
          failures.push(`register ${registered.status}`);
        repoId = registered.body?.repoId;
        failures.push(...registrationFailures(registered.body));
      } finally {
        const code = await result.stop();
        if (code !== 0) failures.push(`stop exit ${code}`);
        if (!released(home)) failures.push('not shut down cleanly');
      }
      return failures;
    });
    await step('restart revalidates the registered spike', async () => {
      const result = await runProductionCli({ home });
      if (result.kind !== 'ready')
        return [`exited ${result.exitCode}: ${result.lines.join(' | ')}`];
      const failures: string[] = [];
      try {
        const api = await session(result.url, result.bootstrapUrl);
        const repos = (await api.call('GET', '/api/v1/repos')).body
          ?.repos as Json[];
        const spike = repos?.find((r) => r.repoId === repoId);
        if (repos?.length !== 1 || !spike)
          failures.push('exactly the spike is registered');
        failures.push(...registrationFailures(spike));
        const health = (await api.call('GET', '/api/v1/health')).body;
        failures.push(...healthFailures(health, orcaHome));
        rate.end = health?.scm?.rateLimit?.remaining;
      } finally {
        const code = await result.stop();
        if (code !== 0) failures.push(`stop exit ${code}`);
        if (!released(home)) failures.push('not shut down cleanly');
      }
      return failures;
    });
    if (!settled)
      steps.push({ name: 'shim ledgered', ok: false, ms: 0, detail: 'none' });

    const after = await spikeInventory(github.api);
    steps.push({
      name: 'spike unchanged (no GitHub writes)',
      ok: JSON.stringify(before) === JSON.stringify(after),
      ms: 0,
    });
    return {
      steps,
      rateLimit: rate,
      githubLedger: github.ledger.data.resources.length,
    };
  });

  // Numbers and step names only; the runner then asserts Orca ledger 0 / scan 0.
  const path = join(h.ledger.dataDir, 't16-production.json');
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.info(`T16 production report: ${path}\n${JSON.stringify(report)}`);
  const failed = report.steps.filter((s) => !s.ok);
  if (failed.length || report.githubLedger !== 0)
    throw new Error(
      `T16 failed:\n- ${failed.map((s) => `${s.name}: ${s.detail ?? ''}`).join('\n- ')}`,
    );
}

/* ------------------------------------------------------------------ T17 prep */

/**
 * The T17 smoke requirement: small, explicit, two work items with one
 * dependency, under a per-run directory so a merged final PR never collides
 * with a later run. `tag` is lowercase alphanumeric (for example the date).
 * One line of at most 256 characters: the final PR title is the requirement.
 */
export function smokeRequirement(tag: string): string {
  if (!/^[a-z0-9]{4,16}$/.test(tag)) throw new Error('Invalid smoke tag');
  return `Smoke test: work item 1 adds smoke/${tag}/greeting.txt with the line "hello from AI Office"; work item 2 depends on it and adds smoke/${tag}/farewell.txt with the line "goodbye from AI Office". No other files.`;
}

/** The task-split the owner approves; used to revise a proposal that differs. */
export function smokeItems(tag: string) {
  return [
    {
      key: 'greeting',
      title: `Add smoke/${tag}/greeting.txt`,
      body: `Create smoke/${tag}/greeting.txt containing exactly one line: \`hello from AI Office\`. Change no other file.`,
      acceptance: [`smoke/${tag}/greeting.txt contains only the greeting line`],
      role: 'engineer',
      agent: 'claude-code',
      deps: [],
    },
    {
      key: 'farewell',
      title: `Add smoke/${tag}/farewell.txt`,
      body: `Create smoke/${tag}/farewell.txt containing exactly one line: \`goodbye from AI Office\`. Work item greeting is already merged into your base; do not modify it. Change no other file.`,
      acceptance: [
        `smoke/${tag}/farewell.txt contains only the farewell line and smoke/${tag}/greeting.txt is present`,
      ],
      role: 'engineer',
      agent: 'codex',
      deps: ['greeting'],
    },
  ];
}

/**
 * A proposed split matches the smoke shape: two items, exactly one dependency,
 * one implemented by Claude and one by Codex.
 */
export function splitMatchesSmoke(items: unknown): boolean {
  if (!Array.isArray(items) || items.length !== 2) return false;
  const keys = new Set(items.map((i: Json) => i?.key));
  const deps = items.flatMap((i: Json) =>
    Array.isArray(i?.deps) ? (i.deps as unknown[]) : [],
  );
  const agents = new Set(items.map((i: Json) => i?.agent));
  return (
    keys.size === 2 &&
    deps.length === 1 &&
    keys.has(deps[0]) &&
    agents.has('claude-code') &&
    agents.has('codex')
  );
}

/**
 * Plays the owner over the API until the final-PR gate opens (the owner then
 * merges by hand on GitHub, Q1) or the workflow ends: the conclusion gate is
 * approved; the task split is approved when it matches, otherwise revised to
 * `smokeItems`. Exception gates go to `onException` (the owner's triage) or
 * fail the drive.
 */
export async function driveSmokeToFinalGate(
  h: OrcaHarness,
  api: Api,
  workflowId: string,
  options: {
    tag: string;
    run: () => Promise<string | undefined>;
    record: DriveRecord;
    onException?: (gate: Json) => Promise<boolean>;
  },
): Promise<{ workflow: Json; finalGate?: Json; revisedSplit: boolean }> {
  let finalGate: Json | undefined;
  let revisedSplit = false;
  const workflow = await drive(
    h,
    api,
    workflowId,
    (w) =>
      finalGate !== undefined ||
      ['completed', 'failed', 'cancelled'].includes(w.status),
    {
      run: options.run,
      record: options.record,
      ...(options.onException ? { onException: options.onException } : {}),
      onStageGate: async (gate) => {
        if (gate.stageKind === 'final-pr') {
          finalGate = gate;
          return true;
        }
        if (gate.stageKind !== 'planning') return false;
        const detail = (
          await api.call(
            'GET',
            `/api/v1/gates/${encodeURIComponent(gate.gateId)}`,
          )
        ).body;
        if (splitMatchesSmoke(detail?.workItems)) return false;
        revisedSplit = true;
        const decided = await decide(api, gate, {
          decision: 'revise',
          edits: { type: 'work-items', items: smokeItems(options.tag) },
        });
        if (decided.status >= 300 && decided.status !== 409)
          throw new Error(`task-split revise ${decided.status}`);
        return true;
      },
    },
  );
  return {
    workflow,
    ...(finalGate ? { finalGate } : {}),
    revisedSplit,
  };
}

/** Open stage gates of one workflow (for T17 reports). */
export const openStageGates = async (api: Api, workflowId: string) =>
  (await gates(api, workflowId)).filter(
    (g) => g.status === 'open' && g.kind === 'stage',
  );

/**
 * N6/§5.4: the repo-local commit identity real agents use in the spike clone
 * (Orca worktrees of the clone share its `.git/config`). PLAN ONLY: the
 * coordinator notifies the owner before anyone runs these commands, and this
 * module never runs them. `email` is the gate's API-derived noreply address.
 */
export function noreplyPlan(clonePath: string, email: string) {
  if (!isAbsolute(clonePath)) throw new Error('Absolute clone path required');
  if (
    !new RegExp(`^\\d+\\+${OWNER}@users\\.noreply\\.github\\.com$`).test(email)
  )
    throw new Error('Owner noreply address required');
  return {
    apply: [
      ['git', '-C', clonePath, 'config', '--local', 'user.name', OWNER],
      ['git', '-C', clonePath, 'config', '--local', 'user.email', email],
    ],
    undo: [
      ['git', '-C', clonePath, 'config', '--local', '--unset', 'user.name'],
      ['git', '-C', clonePath, 'config', '--local', '--unset', 'user.email'],
    ],
  };
}

/** Read-only check T17 runs before dispatching agents. */
export async function noreplyApplied(
  clonePath: string,
  email: string,
): Promise<boolean> {
  const read = (key: string) =>
    git(['config', '--local', '--get', key], clonePath).catch(() => '');
  return (
    (await read('user.name')) === OWNER && (await read('user.email')) === email
  );
}
