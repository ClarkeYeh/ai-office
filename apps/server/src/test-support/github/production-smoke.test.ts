import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkItemDraftSchema } from '@ai-office/contracts/events';
import { readSettings } from '../../config/index.js';
import { parseArgs, startServer } from '../../main.js';
import { runProductionCli } from '../orca/production-cli.js';
import {
  approvedOrcaHome,
  guardGithubReads,
  healthFailures,
  noreplyPlan,
  productionConfig,
  registrationFailures,
  resolveBinary,
  smokeItems,
  smokeRequirement,
  splitMatchesSmoke,
} from './production-smoke.js';

const home = () => mkdtempSync(join(tmpdir(), 'aio-t16-'));
afterEach(() => {
  vi.restoreAllMocks();
});

describe('production config', () => {
  it('writes a valid production config.toml with absolute binaries', () => {
    const dir = home();
    writeFileSync(
      join(dir, 'config.toml'),
      productionConfig({
        orcaBin: '/opt/orca',
        ghBin: '/opt/gh',
        orcaHome: '/Users/owner/.ai-office/orca-home',
        expectedLogin: 'ClarkeYeh',
        enforcement: 'off',
      }),
    );
    const settings = readSettings(dir);
    expect(settings.orca).toMatchObject({
      bin: '/opt/orca',
      homeDir: '/Users/owner/.ai-office/orca-home',
      preventSleep: false,
    });
    expect(settings.github).toMatchObject({
      ghBin: '/opt/gh',
      expectedLogin: 'ClarkeYeh',
      tokenSource: 'auto',
    });
    expect(settings.budget.enforcement).toBe('off');
    expect(() =>
      productionConfig({
        orcaBin: 'orca',
        ghBin: '/opt/gh',
        orcaHome: '/x',
        expectedLogin: 'ClarkeYeh',
      }),
    ).toThrow('Absolute');
  });

  it('uses only the approved orca-home and absolute executables', async () => {
    expect(approvedOrcaHome('/Users/owner')).toBe(
      '/Users/owner/.ai-office/orca-home',
    );
    expect(() => approvedOrcaHome('relative')).toThrow();
    const dir = home();
    const bin = join(dir, 'tool');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    await expect(resolveBinary('tool', undefined, { PATH: dir })).resolves.toBe(
      bin,
    );
    await expect(resolveBinary('tool', bin)).resolves.toBe(bin);
    await expect(resolveBinary('tool', 'tool')).rejects.toThrow('Absolute');
    await expect(
      resolveBinary('missing', undefined, { PATH: dir }),
    ).rejects.toThrow();
  });
});

describe('acceptance checks', () => {
  const health = {
    runtime: {
      mode: 'orca',
      shim: { status: 'ok', location: '/h/.ai-office/orca-home' },
    },
    scm: {
      status: 'healthy',
      login: 'ClarkeYeh',
      tokenSource: 'gh',
      rateLimit: { remaining: 4900 },
      warnings: [],
    },
  };
  it('accepts a production health and names each deviation', () => {
    expect(healthFailures(health, '/h/.ai-office/orca-home')).toEqual([]);
    expect(
      healthFailures(
        {
          ...health,
          scm: {
            ...health.scm,
            tokenSource: 'env',
            warnings: ['expected_login_unset'],
          },
        },
        '/elsewhere',
      ),
    ).toEqual([
      'shim in the approved orca-home',
      'tokenSource gh',
      'expectedLogin pinned',
    ]);
  });
  it('expects the spike registered as protected, merge commits allowed, no warnings', () => {
    const repo = {
      status: 'registered',
      github: { owner: 'ClarkeYeh', name: 'ai-office-spike' },
      ownerLogin: 'ClarkeYeh',
      defaultBranch: 'main',
      visibility: 'public',
      defaultBranchProtected: true,
      allowMergeCommit: true,
      warnings: [],
    };
    expect(registrationFailures(repo)).toEqual([]);
    expect(
      registrationFailures({
        ...repo,
        github: { owner: 'ClarkeYeh', name: 'ai-office' },
        defaultBranchProtected: 'unknown',
        warnings: ['default_protection_unknown'],
      }),
    ).toHaveLength(3);
    expect(registrationFailures(undefined)).not.toEqual([]);
  });
});

describe('GitHub read guard', () => {
  it('passes reads on the spike and account endpoints, refuses everything else offline', async () => {
    const network = vi.fn(async () => new Response('{}'));
    const guard = guardGithubReads(network as unknown as typeof fetch);
    try {
      await fetch('https://api.github.com/user');
      await fetch('https://api.github.com/repos/ClarkeYeh/ai-office-spike');
      await fetch(
        'https://api.github.com/repos/ClarkeYeh/ai-office-spike/branches/main',
      );
      await fetch('http://127.0.0.1:1/api/v1/health');
      for (const [url, init] of [
        [
          'https://api.github.com/repos/ClarkeYeh/ai-office-spike/issues',
          { method: 'POST', body: '{}' },
        ],
        ['https://api.github.com/repos/ClarkeYeh/ai-office', {}],
        ['https://api.github.com/repos/ClarkeYeh/ai-office-spike-x', {}],
      ] as const)
        await expect(fetch(url, init)).rejects.toThrow('non-read');
    } finally {
      guard.restore();
    }
    expect(network).toHaveBeenCalledTimes(4);
    expect(guard.calls).toContain(
      'POST /repos/ClarkeYeh/ai-office-spike/issues',
    );
  });
});

describe('refusal before side effects', () => {
  it('refuses --fake without --dev before creating the data directory', async () => {
    const dir = home();
    await expect(
      startServer({
        ...parseArgs(['--fake', 'mainline']),
        env: { AI_OFFICE_HOME: dir },
        print: () => undefined,
      }),
    ).rejects.toThrow('require --dev');
    expect(existsSync(join(dir, 'data'))).toBe(false);
  });
  it('the built ai-office start refuses --fake without --dev before spawning a backend', async () => {
    const dir = home();
    const result = await runProductionCli({
      home: dir,
      args: ['--fake', 'mainline'],
    });
    expect(result).toMatchObject({ kind: 'exited', exitCode: 1 });
    expect(result.kind === 'exited' && result.lines.join('\n')).toContain(
      'requires --dev',
    );
    expect(existsSync(join(dir, 'data'))).toBe(false);
  });
});

describe('T17 preparation', () => {
  it('states a small explicit requirement with two items and one dependency', () => {
    const text = smokeRequirement('20261119');
    expect(text).toContain('smoke/20261119/greeting.txt');
    expect(text).toContain('work item 2 depends on it');
    // The final PR title is the requirement: one line within GitHub's limit.
    expect(text).not.toContain('\n');
    expect(text.length).toBeLessThanOrEqual(256);
    expect(() => smokeRequirement('../x')).toThrow();
    const items = smokeItems('20261119');
    for (const item of items) WorkItemDraftSchema.parse(item);
    expect(splitMatchesSmoke(items)).toBe(true);
    expect(splitMatchesSmoke(items.slice(0, 1))).toBe(false);
    expect(
      splitMatchesSmoke(items.map((i) => ({ ...i, deps: [] as string[] }))),
    ).toBe(false);
    expect(splitMatchesSmoke([...items, items[0]])).toBe(false);
    expect(
      splitMatchesSmoke(items.map((i) => ({ ...i, agent: 'codex' }))),
    ).toBe(false);
  });
  it('only plans the repo-local noreply identity', () => {
    const plan = noreplyPlan(
      '/clone',
      '12345+ClarkeYeh@users.noreply.github.com',
    );
    expect(plan.apply).toEqual([
      ['git', '-C', '/clone', 'config', '--local', 'user.name', 'ClarkeYeh'],
      [
        'git',
        '-C',
        '/clone',
        'config',
        '--local',
        'user.email',
        '12345+ClarkeYeh@users.noreply.github.com',
      ],
    ]);
    expect(plan.apply.flat()).not.toContain('--global');
    expect(() => noreplyPlan('/clone', 'owner@example.com')).toThrow();
    expect(() =>
      noreplyPlan('clone', '12345+ClarkeYeh@users.noreply.github.com'),
    ).toThrow();
  });
});
