import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');

/**
 * Reads `on.<event>.branches` from a workflow whose triggers use one-line flow
 * sequences. Any other trigger shape throws, so a reformatted file fails loudly
 * instead of passing with an empty list.
 * @param {string} text
 * @returns {Record<string, string[]>}
 */
function triggerBranches(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (start < 0) throw new Error('Workflow has no block `on:` mapping');
  /** @type {Record<string, string[]>} */
  const result = {};
  let event = '';
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (!line.startsWith(' ')) break;
    const eventMatch = /^ {2}([a-z_]+):\s*$/.exec(line);
    if (eventMatch) {
      event = eventMatch[1] ?? '';
      continue;
    }
    const branches = /^ {4}branches:\s*(.*)$/.exec(line);
    if (!branches) continue;
    const flow = /^\[(.*)\]\s*$/.exec(branches[1] ?? '');
    if (!event || !flow)
      throw new Error(`Unsupported branches syntax: ${line.trim()}`);
    result[event] = (flow[1] ?? '')
      .split(',')
      .map((item) => item.trim().replace(/^(['"])(.*)\1$/, '$2'))
      .filter(Boolean);
  }
  return result;
}

test('pull requests into ai-office/** integration branches run CI', () => {
  const triggers = triggerBranches(
    readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'),
  );
  assert.deepEqual(triggers.pull_request, [
    'integration/**',
    'main',
    'ai-office/**',
  ]);
});

test('push triggers stay unchanged so worker pushes do not run CI twice', () => {
  const triggers = triggerBranches(
    readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'),
  );
  assert.deepEqual(triggers.push, ['integration/**', 'main']);
  assert.ok(!triggers.push?.includes('ai-office/**'));
});

test('trigger parser rejects shapes it cannot read', () => {
  assert.deepEqual(
    triggerBranches("on:\n  push:\n    branches: [main, 'a/**']\njobs: {}\n"),
    { push: ['main', 'a/**'] },
  );
  assert.throws(
    () => triggerBranches('on:\n  push:\n    branches:\n      - main\n'),
    /Unsupported branches syntax/,
  );
  assert.throws(() => triggerBranches('on: push\n'), /no block `on:`/);
});
