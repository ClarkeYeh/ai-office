import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fixtureRedactor } from './redaction.ts';

const claude = (value: unknown = 12) => ({
  type: 'assistant',
  message: {
    id: 'message-1',
    usage: { input_tokens: value, output_tokens: 3 },
  },
});
const codex = (value: unknown = 12) => ({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: value,
        output_tokens: 3,
        total_tokens: 15,
      },
    },
  },
});
const scoped = () => fixtureRedactor('fixtures/usage/example.json');

describe('usage fixture counter exception', () => {
  it('preserves only numeric usage fields in recognized provider records', () => {
    const value = [claude(), codex()];
    expect(scoped().sanitize(value)).toEqual(value);
    expect(scoped().hasLeaks(value)).toBe(false);
    for (const name of [
      'claude',
      'codex',
      'claude-code-2.1.311',
      'codex-0.171.0',
    ]) {
      const contents: unknown = JSON.parse(
        readFileSync(`fixtures/usage/${name}.json`, 'utf8'),
      );
      expect(scoped().hasLeaks(contents)).toBe(false);
    }
  });
  it('preserves the codex-cli 0.171.0 cache_write_input_tokens counter', () => {
    const value = codex();
    Object.assign(value.payload.info.total_token_usage, {
      cache_write_input_tokens: 4,
    });
    expect(scoped().sanitize(value)).toEqual(value);
    expect(scoped().hasLeaks(value)).toBe(false);
    Object.assign(value.payload.info.total_token_usage, {
      cache_write_input_tokens: '4',
    });
    expect(scoped().hasLeaks(value)).toBe(true);
  });
  it.each(['12', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, { value: 12 }])(
    'still flags non-counter values (%j)',
    (value) => {
      expect(scoped().hasLeaks(claude(value))).toBe(true);
      expect(scoped().hasLeaks(codex(value))).toBe(true);
    },
  );
  it('does not allow counters outside the exact fixture subtree or provider shape', () => {
    for (const path of [
      undefined,
      'fixtures/other.json',
      'fixtures/usage-other/example.json',
      'fixtures/usage/../example.json',
    ])
      expect(fixtureRedactor(path).hasLeaks([claude(), codex()])).toBe(true);
    for (const row of [
      { input_tokens: 12 },
      { type: 'user', message: claude().message },
      { type: 'event_msg', payload: { ...codex().payload, type: 'other' } },
      { wrapper: claude() },
      { ...claude(), input_tokens: 12 },
    ])
      expect(scoped().hasLeaks(row)).toBe(true);
  });
  it('keeps unknown keys, credential fields, and transcript content protected', () => {
    expect(
      scoped().hasLeaks({ ...claude(), content: 'synthetic transcript' }),
    ).toBe(true);
    const extra = codex();
    Object.assign(extra.payload.info.total_token_usage, { other_tokens: 12 });
    expect(scoped().hasLeaks(extra)).toBe(true);
    const secret = claude();
    Object.assign(secret.message.usage, {
      access_token: 'synthetic-secret',
      other_tokens: 12,
    });
    const sanitized = JSON.stringify(scoped().sanitize(secret));
    expect(sanitized).not.toContain('synthetic-secret');
    expect(scoped().hasLeaks(secret)).toBe(true);
  });
  it('applies the same path restriction in sanitizer and scanner CLIs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'usage-fixture-check-'));
    const cli = (name: string, args: string[]) =>
      spawnSync(
        process.execPath,
        [resolve(`scripts/fixtures/${name}.ts`), ...args],
        { cwd: directory, encoding: 'utf8' },
      );
    try {
      mkdirSync(join(directory, 'fixtures/usage'), { recursive: true });
      const path = join(directory, 'fixtures/usage/sample.json');
      const records = [claude(), codex()];
      writeFileSync(path, JSON.stringify(records));
      const sanitized = cli('sanitize', ['fixtures/usage/sample.json']);
      expect(sanitized.status).toBe(0);
      expect(JSON.parse(sanitized.stdout)).toEqual(records);
      expect(cli('scan', ['fixtures']).status).toBe(0);
      writeFileSync(path, JSON.stringify([claude('synthetic-secret')]));
      const rejected = cli('scan', ['fixtures']);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).not.toContain('synthetic-secret');
      writeFileSync(path, JSON.stringify(records));
      writeFileSync(
        join(directory, 'fixtures/other.json'),
        JSON.stringify(records),
      );
      expect(cli('scan', ['fixtures']).status).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
