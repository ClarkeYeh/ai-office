import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRedactor } from './index.js';
const { maskText, sanitize, summarize, hasLeaks } = createRedactor({
  preservedRepoUrls: ['https://github.com/ClarkeYeh/ai-office-spike'],
});
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
});
