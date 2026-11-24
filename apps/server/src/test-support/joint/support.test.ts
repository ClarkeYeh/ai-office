import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OWNER_PORT, assertIsolated, freePort, pinPort } from './backends.js';
import { MASKED_TARGETS, REPO_ROOT, writeJointExports } from './export-run.js';
import { HealthSampler, summarize, toSample } from './sampler.js';

describe('health sampler', () => {
  it('keeps numbers only and summarizes peaks', () => {
    const health = {
      runtime: { cliCallsPerMinute: 12, binPath: '/secret/path' },
      scm: { rateLimit: { remaining: 4900 }, login: 'someone' },
      adapters: [
        { adapter: 'scm', calls: 30, failures: 1 },
        { adapter: 'runtime', calls: 50, failures: 0 },
      ],
    };
    const a = toSample(health, 1);
    expect(a).toEqual({
      at: 1,
      cliCallsPerMinute: 12,
      remaining: 4900,
      adapters: {
        scm: { calls: 30, failures: 1 },
        runtime: { calls: 50, failures: 0 },
      },
    });
    const b = toSample(
      {
        runtime: { cliCallsPerMinute: 40 },
        scm: { rateLimit: { remaining: 4800 } },
        adapters: [{ adapter: 'scm', calls: 10, failures: 0 }],
      },
      2,
    );
    expect(summarize([a, b, toSample(null, 3)], 2)).toEqual({
      samples: 3,
      failedReads: 2,
      maxCliCallsPerMinute: 40,
      maxAdapterCalls: { scm: 30, runtime: 50 },
      remaining: { first: 4900, last: 4800, min: 4800 },
    });
  });

  it('counts failed reads during the downtime instead of throwing', async () => {
    let up = false;
    const sampler = new HealthSampler(
      () => ({
        call: async () => {
          if (!up) throw new Error('ECONNREFUSED');
          return { status: 200, body: { adapters: [] } };
        },
      }),
      { now: () => 7 },
    );
    await sampler.sample();
    up = true;
    await sampler.sample();
    expect(sampler.stop()).toMatchObject({ samples: 1, failedReads: 1 });
  });
});

describe('isolated backend homes', () => {
  it("refuses the owner's home and port", () => {
    expect(() =>
      assertIsolated(join(process.env.HOME!, '.ai-office'), 40_000),
    ).toThrow('~/.ai-office');
    expect(() => assertIsolated('/tmp/x', OWNER_PORT)).toThrow('4319');
    expect(() => assertIsolated('/tmp/x', 0)).toThrow('fixed port');
    expect(() => assertIsolated('/tmp/x', 40_000)).not.toThrow();
  });

  it('pins a free port into config.toml', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aio-joint-'));
    await writeFile(
      join(dir, 'config.toml'),
      '[budget]\nenforcement = "off"\n',
    );
    const port = await freePort();
    expect(port).not.toBe(OWNER_PORT);
    await pinPort(dir, port);
    expect(await readFile(join(dir, 'config.toml'), 'utf8')).toBe(
      `[budget]\nenforcement = "off"\n[server]\nport = ${port}\n`,
    );
  });
});

describe('B4 export step', () => {
  const events = [
    {
      seq: 1,
      type: 'workflow.started',
      occurredAt: '2026-11-24T00:00:00.000Z',
      payload: { requirement: 'R', shortId: 'abcd1234' },
    },
    {
      seq: 2,
      type: 'meeting.statement',
      occurredAt: '2026-11-24T00:00:01.000Z',
      payload: { stageId: 'meeting', summary: 'free text from an agent' },
    },
  ];
  const meta = {
    exportedAt: '2026-11-24T00:00:00.000Z',
    aiOfficeCommit: 'a'.repeat(40),
    orcaVersion: '1.4.272',
    requirements: ['R'],
  };

  it('writes the raw log privately (0600) and the masked log beside it', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'aio-joint-')), 'private');
    const result = await writeJointExports(events, {
      ...meta,
      privateDir: dir,
      name: 'm5-joint-test',
    });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(result.rawPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(result.rawPath, 'utf8')).events).toEqual(
      events,
    );
    const masked = await readFile(result.maskedPaths[0]!, 'utf8');
    expect(masked).not.toContain('free text from an agent');
    expect(masked).toContain('‹text len=23');
  });

  it('writes both committed targets only when a masked dir is given', async () => {
    const base = await mkdtemp(join(tmpdir(), 'aio-joint-'));
    const result = await writeJointExports(events, {
      ...meta,
      privateDir: join(base, 'private'),
      maskedDir: join(base, 'repo'),
      name: 'm5-joint-test',
      repoRoot: join(base, 'repo'),
    });
    expect(result.maskedPaths).toEqual(
      MASKED_TARGETS.map((t) => join(base, 'repo', t)),
    );
  });

  it('never writes a raw export inside the repository or with bad metadata', async () => {
    await expect(
      writeJointExports(events, {
        ...meta,
        privateDir: join(REPO_ROOT, 'fixtures', 'm5'),
        name: 'x',
      }),
    ).rejects.toThrow('inside the repository');
    await expect(
      writeJointExports(events, { ...meta, privateDir: 'relative', name: 'x' }),
    ).rejects.toThrow('absolute');
    const dir = join(await mkdtemp(join(tmpdir(), 'aio-joint-')), 'p');
    await expect(
      writeJointExports(events, {
        ...meta,
        aiOfficeCommit: 'nope',
        privateDir: dir,
        name: 'x',
      }),
    ).rejects.toThrow('Invalid export metadata');
    await expect(stat(dir)).rejects.toThrow(); // nothing written
  });
});
