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

  it('does not exempt arbitrary hex secrets or lose colliding redacted keys', () => {
    expect(
      hasLeaks({
        value: createHash('sha256').update('synthetic secret').digest('hex'),
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
