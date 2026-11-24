import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Needs the built server (pnpm -r build), like the CLI itself.
const { syntheticMainline } =
  await import('../../apps/server/dist/test-support/acceptance-check/synthetic.js');
const script = fileURLToPath(new URL('./check.mjs', import.meta.url));

/**
 * @param {Record<string, unknown>} files
 * @param {string[]} args
 */
function run(files, args) {
  const root = mkdtempSync(join(tmpdir(), 'aio-acceptance-'));
  try {
    for (const [name, value] of Object.entries(files))
      writeFileSync(join(root, name), JSON.stringify(value));
    return spawnSync(
      process.execPath,
      [script, ...args.map((a) => (a in files ? join(root, a) : a))],
      { encoding: 'utf8' },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('all judged rows pass on the export envelope with facts', () => {
  const { events, facts } = syntheticMainline();
  const result = run(
    {
      'events.json': { exportedAt: '2000-01-01T00:00:00.000Z', events },
      'facts.json': facts,
    },
    ['events.json', '--github-facts', 'facts.json'],
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^✅ v01\.rework — /m);
  assert.match(result.stdout, /^N\/A nf\.cpu — /m);
  assert.match(result.stdout, /^17 ✅ {2}0 ❌ {2}6 N\/A$/m);
});

test('a ❌ row exits 1; --json prints the report', () => {
  const { events, facts } = syntheticMainline();
  const result = run(
    {
      'events.json': events,
      'facts.json': { ...facts, approveCommentNoStateChange: false },
    },
    ['events.json', '--github-facts', 'facts.json', '--json'],
  );
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(
    report.rows.find(
      (/** @type {{ id: string }} */ r) => r.id === 'nf.approve-comment',
    ).verdict,
    'fail',
  );
});

test('usage and input errors exit 2', () => {
  const { events } = syntheticMainline();
  assert.equal(run({}, []).status, 2);
  assert.equal(
    run({ 'e.json': events }, ['e.json', '--github-facts']).status,
    2,
  );
  const unknown = run({ 'e.json': events, 'f.json': { typo: true } }, [
    'e.json',
    '--github-facts',
    'f.json',
  ]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown GitHub fact: typo/);
  assert.equal(run({ 'e.json': { rows: [] } }, ['e.json']).status, 2);
});
