import { expect, it } from 'vitest';
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fixtureRedactor } from './redaction.ts';

const ref = 'refs/heads/ai-office/t000000000001-encoded/path';
it('limits ref preservation to GitHub fixtures and leaves all secret/body rules enabled', () => {
  const scan = fixtureRedactor('fixtures/github/example.json');
  expect(scan.hasLeaks({ ref })).toBe(false);
  for (const path of [
    undefined,
    'fixtures/orca/example.json',
    'fixtures/github-foreign/example.json',
  ])
    expect(fixtureRedactor(path).hasLeaks({ ref })).toBe(true);
  for (const value of [
    { ref: ref + '/ghp_SyntheticSecret123456789' },
    { ref: ref + '/github_pat_SyntheticSecret123456789' },
    { ref: ref + '/user@example.org' },
    { ref: ref + '/home/synthetic/private' },
    { ref: ref + '/Users/synthetic/private' },
    { body: ref },
    { token: { ref } },
    { body: 'user@example.org' },
  ])
    expect(scan.hasLeaks(value)).toBe(true);
});
it('uses identical narrow ref handling at recording and fixture-scan boundaries', () => {
  const source = (path: string) =>
    readFileSync(path, 'utf8').replace(
      /\/\*\* Fixture-only exception;[^\n]+\n/,
      '',
    );
  expect(source('scripts/fixtures/github-redaction.ts')).toBe(
    source('apps/server/src/test-support/github/ref-redaction.ts'),
  );
});
it('scans preserved refs on disk and rejects a planted token in a ref segment', () => {
  const root = mkdtempSync(join(tmpdir(), 'github-fixture-scan-'));
  try {
    const directory = join(root, 'fixtures/github');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, 'ref.json');
    const run = () =>
      spawnSync(
        process.execPath,
        [resolve('scripts/fixtures/scan.ts'), 'fixtures/github'],
        { cwd: root, encoding: 'utf8' },
      );
    writeFileSync(file, JSON.stringify({ ref }));
    expect(run().status).toBe(0);
    writeFileSync(
      file,
      JSON.stringify({ ref: ref + '/ghp_SyntheticSecret123456789' }),
    );
    expect(run().status).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
