import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function directory(): string {
  const result = mkdtempSync(join(tmpdir(), 'fixture-check-'));
  directories.push(result);
  return result;
}
function cli(name: string, args: string[] = [], input?: string) {
  return spawnSync(process.execPath, [`scripts/fixtures/${name}.ts`, ...args], {
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
}

describe('fixture command-line tools', () => {
  it('sanitizes stdin and file input, then scans nested JSON', () => {
    const root = directory();
    const raw = join(root, 'raw.json');
    writeFileSync(
      raw,
      JSON.stringify({
        input: 'sensitive tool input',
        email: 'tester@example.com',
      }),
    );
    const fileResult = cli('sanitize', [raw]);
    expect(fileResult.status).toBe(0);
    expect(
      cli(
        'sanitize',
        [],
        '{"input":"sensitive tool input","email":"tester@example.com"}',
      ).stdout,
    ).toBe(fileResult.stdout);
    const fixtures = join(root, 'fixtures');
    mkdirSync(join(fixtures, 'nested'), { recursive: true });
    writeFileSync(join(fixtures, 'nested', 'sample.json'), fileResult.stdout);
    expect(cli('scan', [fixtures]).status).toBe(0);
  });

  it.each([
    ['sample.json', '{"value":"test@example.com"}'],
    ['sample.json', JSON.stringify({ path: '/Users/test/private' })],
    ['sample.json', JSON.stringify({ path: '/Users/<redacted>/private' })],
    ['sample.json', '{"path":"\\u002fUsers\\u002f<redacted>/private"}'],
    ['README.md', '/home/test/private'],
    ['sample.json', '{"handle":"term_12345678-1234-4234-8234-123456789abc"}'],
    ['sample.json', '{"output":"ordinary tool output"}'],
    ['sample.json', '{"value":"\\u0074est@example.com"}'],
    ['sample.json', '{invalid'],
    ['sample.json', '\0'],
    ['sample.txt', 'ordinary tool output'],
    ['test@example.com.json', '{}'],
    ['README.md', 'test@example.com'],
  ])(
    'rejects unsafe fixture %# without logging its content',
    (name, content) => {
      const root = directory();
      writeFileSync(join(root, name), content);
      const result = cli('scan', [root]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain('test@example.com');
      expect(result.stderr).not.toContain(root);
    },
  );

  it('rejects symlinks and missing directories', () => {
    const root = directory();
    symlinkSync('/nonexistent', join(root, 'link.json'));
    expect(cli('scan', [root]).status).toBe(1);
    expect(cli('scan', [join(root, 'missing')]).status).toBe(1);
  });

  it('does not echo malformed JSON or emit partial output', () => {
    const result = cli('sanitize', [], '{"token":"sensitive-raw-data"');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('sensitive-raw-data');
  });
});

describe('replay fidelity', () => {
  const uuid = '528e2760-fb33-421f-9706-a7c5c19df281';
  const sha = createHash('sha1').update('public commit').digest('hex');
  const identifiers = [
    'seat.status',
    'workflow.started',
    'feature-to-pr.yaml',
    'src/index.ts',
    'a.b',
    '01JCZ8Q4V7XK3M9N2P5R6S8T0W',
    uuid,
    sha,
    createHash('sha256').update('public content').digest('hex'),
    ...['term', 'ctx', 'task', 'run', 'msg'].flatMap((prefix) => [
      `${prefix}_${uuid}`,
      `${prefix}_4fb346313714`,
    ]),
  ];

  it('round-trips realistic Orca and GitHub JSON without losing replay metadata', () => {
    const raw = {
      ok: true,
      result: {
        runId: 'run_4fb346313714',
        terminalHandle: `term_${uuid}`,
        dispatchId: 'ctx_4fb346313714',
        taskId: 'task_9d8702c5776d',
        messages: [
          {
            id: 'msg_e06dd897556e',
            kind: 'seat.status',
            status: 'working',
            eventId: identifiers[5],
            hostname: 'worker.local',
            input: 'sensitive command',
          },
        ],
      },
      pullRequest: {
        number: 3,
        html_url: 'https://github.com/ClarkeYeh/ai-office-spike/pull/3',
        head: { sha },
        expectedHeadSha: sha,
        body: 'private body',
      },
      template: 'feature-to-pr.yaml',
      file: 'src/index.ts',
    };
    const result = cli('sanitize', [], JSON.stringify(raw));
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as typeof raw;
    expect(parsed.result).toMatchObject({
      runId: raw.result.runId,
      terminalHandle: 'term_00000000-0000-4000-8000-000000000001',
      dispatchId: raw.result.dispatchId,
      taskId: raw.result.taskId,
      messages: [
        {
          id: 'msg_e06dd897556e',
          kind: 'seat.status',
          status: 'working',
          eventId: identifiers[5],
        },
      ],
    });
    expect(parsed.pullRequest).toMatchObject({
      number: 3,
      head: { sha },
      expectedHeadSha: sha,
      html_url: raw.pullRequest.html_url,
    });
    expect(parsed.template).toBe(raw.template);
    expect(parsed.file).toBe(raw.file);
    expect(result.stdout).not.toMatch(
      /sensitive command|private body|worker.local/,
    );
    const root = directory();
    writeFileSync(join(root, 'round-trip.json'), result.stdout);
    writeFileSync(
      join(root, 'harmless.json'),
      '{"kind":"seat.status","ok":true}',
    );
    expect(cli('scan', [root]).status).toBe(0);
    expect(cli('sanitize', [], result.stdout).stdout).toBe(result.stdout);
  });
});

it('uses the same environment override for sanitizer and scanner', () => {
  const root = directory();
  const env = {
    ...process.env,
    AIO_FIXTURE_REPO_URLS: 'https://github.com/example/public-repo',
  };
  const url = 'https://github.com/example/public-repo/pull/1';
  const result = spawnSync(process.execPath, ['scripts/fixtures/sanitize.ts'], {
    encoding: 'utf8',
    env,
    input: JSON.stringify({ url }),
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ url });
  writeFileSync(join(root, 'sample.json'), result.stdout);
  expect(
    spawnSync(process.execPath, ['scripts/fixtures/scan.ts', root], { env })
      .status,
  ).toBe(0);
  expect(
    spawnSync(process.execPath, ['scripts/fixtures/scan.ts', root], {
      env: { ...env, AIO_FIXTURE_REPO_URLS: '' },
    }).status,
  ).toBe(1);
});

it('reports invalid configuration without echoing credentials', () => {
  for (const script of ['sanitize', 'scan']) {
    const result = spawnSync(
      process.execPath,
      [`scripts/fixtures/${script}.ts`],
      {
        encoding: 'utf8',
        input: '{}',
        env: {
          ...process.env,
          AIO_FIXTURE_REPO_URLS: 'https://user:private@github.com/a/b',
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('private');
  }
});
