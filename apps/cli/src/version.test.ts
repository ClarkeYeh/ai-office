import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { runCli } from './index.js';
import { version } from './version.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function build(files: Record<string, string>): URL {
  const root = mkdtempSync(join(tmpdir(), 'aio-version-'));
  roots.push(root);
  mkdirSync(join(root, 'dist'));
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(root, name), text);
  return pathToFileURL(join(root, 'dist') + '/');
}

test('prints the package version and the embedded commit', () => {
  const directory = build({
    'package.json': JSON.stringify({ version: '0.1.0' }),
    'dist/build-info.json': JSON.stringify({ commit: 'abc1234' }),
  });
  expect(version(directory)).toEqual({
    exitCode: 0,
    message: 'ai-office 0.1.0 (commit abc1234)',
  });
});

test.each([
  ['missing', {}],
  ['invalid', { 'dist/build-info.json': '{"commit":"$(git log)"}' }],
  ['malformed', { 'dist/build-info.json': 'not json' }],
])('falls back to unknown when build info is %s', (_name, files) => {
  const directory = build({
    'package.json': JSON.stringify({ version: '0.1.0' }),
    ...files,
  });
  expect(version(directory).message).toBe('ai-office 0.1.0 (commit unknown)');
});

test.each(['--version', '-v'])(
  '%s reports the workspace version',
  async (arg) => {
    expect(await runCli([arg])).toEqual({
      exitCode: 0,
      message: expect.stringMatching(
        /^ai-office 0\.1\.0 \(commit (?:[0-9a-f]{4,40}|unknown)\)$/,
      ),
    });
  },
);
