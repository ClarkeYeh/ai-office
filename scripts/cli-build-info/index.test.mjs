import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeBuildInfo } from './index.mjs';

/** @param {(() => string) | undefined} git */
function build(git) {
  const directory = mkdtempSync(join(tmpdir(), 'aio-build-info-'));
  try {
    const commit = writeBuildInfo(directory, git);
    const file = JSON.parse(
      readFileSync(join(directory, 'build-info.json'), 'utf8'),
    );
    assert.deepEqual(file, { commit });
    return commit;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('build info embeds the short sha', () => {
  assert.equal(
    build(() => 'abc1234\n'),
    'abc1234',
  );
});

test('build info falls back to unknown without git', () => {
  assert.equal(
    build(() => {
      throw new Error('spawn git ENOENT');
    }),
    'unknown',
  );
  assert.equal(
    build(() => 'fatal: not a git repository'),
    'unknown',
  );
});

test('build info outside a checkout is unknown', () => {
  assert.equal(build(undefined), 'unknown');
});
