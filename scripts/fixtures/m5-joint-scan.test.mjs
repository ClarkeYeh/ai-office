import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');

// M5-T17: fixtures/web/m5-joint.events.json is T12's B4 masked export (the
// same file as fixtures/m5/joint.events.json), so it gets the fixtures/m5
// rule; every other fixtures/web/*.events.json keeps the M4 web-event rule.

/** @param {number} seq @param {string} type @param {Record<string, unknown>} payload */
const event = (seq, type, payload) => ({
  seq,
  id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(seq).padStart(2, '0')}`,
  occurredAt: '2000-01-01T00:00:00.000Z',
  recordedAt: '2000-01-01T00:00:00.000Z',
  workflowId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  source: 'engine',
  provenance: 'decided',
  schemaVersion: 1,
  type,
  payload,
});
const b4 = (extra = {}) => ({
  exportedAt: '2000-01-01T00:00:00.000Z',
  aiOfficeCommit: 'a'.repeat(40),
  orcaVersion: '1.2.3',
  events: [
    event(1, 'command.issued', {
      commandId: '‹text len=68 sha=62615bf46775›',
      kind: 'scm.mergePR',
    }),
    event(2, 'timer.scheduled', {
      timerId: '‹text len=149 sha=656a803c2006›',
      fireAt: '‹text len=24 sha=4b3bf48796a5›',
    }),
    event(3, 'seat.status', {
      attemptId: '‹text len=51 sha=0da1711b2638›',
      state: 'waiting_input',
      ...extra,
    }),
  ],
});

/** @param {Record<string, unknown>} files @returns {number | null} */
function scan(files) {
  const directory = mkdtempSync(join(tmpdir(), 'aio-t17-scan-'));
  try {
    mkdirSync(join(directory, 'fixtures/web'), { recursive: true });
    for (const [name, value] of Object.entries(files))
      writeFileSync(join(directory, name), JSON.stringify(value));
    return spawnSync(
      process.execPath,
      [join(root, 'scripts/fixtures/scan.ts')],
      { cwd: directory, encoding: 'utf8' },
    ).status;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('m5-joint: a B4 envelope with command/timer events passes', () => {
  assert.equal(scan({ 'fixtures/web/m5-joint.events.json': b4() }), 0);
});

test('m5-joint: long natural text fails', () => {
  assert.equal(
    scan({
      'fixtures/web/m5-joint.events.json': b4({
        note: 'Private natural language from an agent. '.repeat(4),
      }),
    }),
    1,
  );
});

test('m5-joint: an email fails', () => {
  assert.equal(
    scan({
      'fixtures/web/m5-joint.events.json': b4({ by: 'someone@example.com' }),
    }),
    1,
  );
});

test('m5-joint: real Orca ids and UUIDs fail, the masker pseudonyms pass', () => {
  for (const by of [
    'orca:tx:ctx_6bedc4cc570a:x:seat.activity',
    'run_a1b2c3d4e5f6',
    'msg_01AbCdEfGhIjKlMnOpQrStUv',
    '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  ])
    assert.equal(
      scan({ 'fixtures/web/m5-joint.events.json': b4({ by }) }),
      1,
      by,
    );
  assert.equal(
    scan({
      'fixtures/web/m5-joint.events.json': b4({
        by: 'orca:tx:ctx_000000000001:00000000-0000-4000-8000-000000000001:seat.activity',
        run: 'run_000000000002',
      }),
    }),
    0,
  );
});

test('other web fixtures keep the web rule: the same B4 file fails', () => {
  assert.equal(scan({ 'fixtures/web/other.events.json': b4() }), 1);
});

test('other web fixtures keep the web rule: command/timer events fail', () => {
  const events = b4().events.map((e) => ({
    ...e,
    payload:
      e.type === 'seat.status'
        ? { attemptId: 'a1', state: 'waiting_input' }
        : e.payload,
  }));
  assert.equal(scan({ 'fixtures/web/other.events.json': events }), 1);
  // Control: the seat.status event alone is a valid web fixture.
  assert.equal(scan({ 'fixtures/web/other.events.json': events.slice(2) }), 0);
});
