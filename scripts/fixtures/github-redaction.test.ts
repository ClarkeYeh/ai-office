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

it('keeps a structural request path only in GitHub fixtures and only for its exact template', () => {
  const root = '/repos/ClarkeYeh/ai-office-spike';
  const signature = (path: string, template = '/pulls/{number}') => ({
    method: 'GET',
    pathTemplate: '/repos/{owner}/{repo}' + template,
    path: root + path,
  });
  const scan = fixtureRedactor('fixtures/github/example.json');
  expect(scan.hasLeaks([signature('/pulls/144')])).toBe(false);
  expect(
    scan.hasLeaks([
      signature('/issues/57/comments', '/issues/{number}/comments'),
    ]),
  ).toBe(false);
  expect(fixtureRedactor().hasLeaks([signature('/pulls/144')])).toBe(true);
  for (const value of [
    signature('/pulls/144x9Kq2Zr7Lm3Vb8Wq'),
    signature('/pulls/144', '/issues/{number}'),
    signature(
      '/git/ref/heads/ai-office/ghp_SyntheticSecret123456789',
      '/git/ref/heads/{ref}',
    ),
    { path: root + '/pulls/144' },
  ])
    expect(scan.hasLeaks([value])).toBe(true);
});

it('keeps a product branch only as a ref value and only in its exact form', () => {
  const scan = fixtureRedactor('fixtures/github/example.json');
  const branch = 'ai-office/1cd773791d59-smoke-test-work-item-1-adds-smok';
  expect(scan.hasLeaks({ head: { ref: branch } })).toBe(false);
  expect(scan.maskText(branch)).toBe(branch);
  expect(fixtureRedactor().hasLeaks({ ref: branch })).toBe(true);
  for (const value of [
    { label: `ClarkeYeh:${branch}` },
    { ref: 'ai-office/1cd773791d59-Smoke_x9Kq2Zr7Lm3Vb8Wq' },
    { ref: 'ai-office/1cd773791d59-ghp_SyntheticSecret123456789' },
    { ref: 'ai-office/1cd773791d59-sk-x9kq2zr7lm3vb8wq5tn1' },
    // Lowercase high-entropy words are not a slug either.
    { ref: 'ai-office/1cd773791d59-q7x9m2k4p8w3z6r1t5y0u2i8o4p6a3s9d1f7g5h2' },
    {
      ref: 'ai-office/1cd773791d59-fix-q7x9m2k4p8w3z6r1t5y0u2i8o4p6a3s9d1f7g5h2',
    },
    { ref: 'other/1cd773791d59-smoke-test-work-item-1-adds-smok' },
  ])
    expect(scan.hasLeaks(value)).toBe(true);
});
