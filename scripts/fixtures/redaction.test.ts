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
import { hasLeaks, maskText, sanitize, summarize } from './redaction.ts';

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

describe('fixture redaction', () => {
  it.each([
    'worker@example.com',
    'ghp_' + 'a'.repeat(36),
    'gho_' + 'b'.repeat(36),
    'github_pat_' + 'c'.repeat(40),
    'sk-proj-' + 'd'.repeat(40),
    'sk-ant-api03-' + 'e'.repeat(40),
    'aio_seat_' + 'f'.repeat(30),
    'q7Rz9Vm2Lp8Nx4Kd6Hs3Jt5Wc0Ba1Yuf',
    '-----BEGIN PRIVATE KEY-----\nABCDEF\n-----END PRIVATE KEY-----',
    'dev-machine.local',
    'https://api.github.com/repos/test/fixture',
    '192.168.1.23',
    'localhost',
    'Alice-MacBook-Pro',
  ])('detects and masks sensitive string %#', (sample) => {
    expect(maskText(sample)).not.toContain(sample);
    expect(hasLeaks({ value: sample })).toBe(true);
    expect(hasLeaks(sanitize({ value: sample }))).toBe(false);
  });

  it('preserves home path structure without the username', () => {
    expect(maskText('/Users/alice/work/repo')).toBe(
      '/Users/<redacted>/work/repo',
    );
    expect(maskText('/home/alice/work')).toBe('/home/<redacted>/work');
    expect(maskText('C:\\Users\\alice\\work')).toBe(
      'C:\\Users\\<redacted>\\work',
    );
  });

  it('sanitizes nested Orca and GitHub responses and sensitive keys', () => {
    const recorded = {
      ok: true,
      runId: 'test-run-1',
      result: [
        {
          toolName: 'exec',
          durationMs: 12,
          input: { command: 'cat private-file' },
          output: 'private response',
          hostname: 'laptop',
        },
      ],
      issue: {
        number: 4,
        body: 'private issue body',
        user: { email: 'worker@example.com' },
      },
      headers: { Authorization: 'Bearer short', cookie: 'session=short' },
      'worker@example.com': 'contact',
    };
    const sanitized = sanitize(recorded);
    expect(hasLeaks(recorded)).toBe(true);
    expect(hasLeaks(sanitized)).toBe(false);
    expect(sanitize(sanitized)).toEqual(sanitized);
    expect(sanitized).toMatchObject({
      ok: true,
      runId: 'test-run-1',
      headers: { Authorization: '<redacted>', cookie: '<redacted>' },
    });
    expect(JSON.stringify(sanitized)).not.toMatch(
      /private response|private issue body|cat private-file|worker@example|laptop/,
    );
  });

  it.each([
    'input',
    'tool_input',
    'toolOutput',
    'arguments',
    'stdout',
    'stderr',
    'transcript',
    'fileContent',
    'commandOutput',
    'agentText',
    'body',
    'content',
    'text',
  ])('summarizes %s regardless of secret patterns', (key) => {
    expect(sanitize({ [key]: 'ordinary words' })).toEqual({
      [key]: summarize('ordinary words'),
    });
    expect(hasLeaks({ [key]: 'ordinary words' })).toBe(true);
  });

  it('uses UTF-8 byte length and SHA-256 of the original body', () => {
    const input = '測試🦀';
    expect(summarize(input)).toBe(
      `<redacted length=10 sha256=${createHash('sha256').update(input).digest('hex')}>`,
    );
    expect(hasLeaks({ input: summarize(input) })).toBe(false);
    expect(hasLeaks({ output: '<redacted length=10 sha256=invalid>' })).toBe(
      true,
    );
  });

  it('masks secrets even when shaped like IDs and rejects colliding keys', () => {
    expect(
      hasLeaks({
        apiKey: createHash('sha256').update('synthetic secret').digest('hex'),
      }),
    ).toBe(true);
    expect(() =>
      sanitize({ 'one@example.com': 1, 'two@example.com': 2 }),
    ).toThrow('collision');
  });
});

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

  it.each(identifiers)('preserves replay identifier %s', (id) => {
    expect(sanitize({ id })).toEqual({ id });
    expect(hasLeaks({ id })).toBe(false);
  });

  it('retains test-repo URLs while masking other repositories and credentials', () => {
    const url = 'https://github.com/ClarkeYeh/ai-office-spike/pull/3';
    expect(maskText(url)).toBe(url);
    expect(maskText(`See ${url} for details`)).toBe(`See ${url} for details`);
    expect(maskText(url.replace('https://', 'https://alice:password@'))).toBe(
      url,
    );
    for (const unsafe of [
      url.replace('ai-office-spike', 'private-project'),
      url.replace('ai-office-spike', 'ai-office-spike-extra'),
      url.replace('github.com', 'github.com.evil.net'),
      url.replace('https://', 'http://'),
    ])
      expect(maskText(unsafe)).toBe('<redacted>');
    const sanitized = maskText(`${url}?token=short&ref=${sha}`);
    expect(sanitized).not.toContain('short');
    expect(sanitized).toContain(sha);
    expect(maskText(sanitized)).toBe(sanitized);
  });

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
      terminalHandle: raw.result.terminalHandle,
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
