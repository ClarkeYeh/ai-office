import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRedactor } from '@ai-office/redaction';
import { safeWebEvents } from './scan-events.mjs';
const redactor = createRedactor({
  preservedRepoUrls: ['https://github.com/ClarkeYeh/ai-office-spike'],
});
test('web event scanner admits schema-valid events and rejects private or secret data', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../fixtures/web/demo.events.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(safeWebEvents(fixture, redactor), true);
  assert.equal(safeWebEvents([{ bad: true }], redactor), false);
  const envelope = {
    seq: 1,
    id: '00000000000000000000000001',
    occurredAt: '1970-01-01T00:00:00.000Z',
    recordedAt: '1970-01-01T00:00:00.000Z',
    workflowId: null,
    source: 'engine',
    provenance: 'decided',
    schemaVersion: 1,
  };
  assert.equal(
    safeWebEvents(
      [
        {
          ...envelope,
          type: 'command.succeeded',
          payload: { commandId: 'cmd', kind: 'runtime.stop', result: {} },
        },
      ],
      redactor,
    ),
    false,
  );
  assert.equal(
    safeWebEvents(
      [
        {
          ...envelope,
          type: 'workflow.failed',
          payload: { reason: 'ghp_FAKESECRET12345678901234567890' },
        },
      ],
      redactor,
    ),
    false,
  );
  assert.equal(
    safeWebEvents(
      [
        {
          ...envelope,
          type: 'workflow.failed',
          payload: { reason: 'safe' },
          transcript: 'private',
        },
      ],
      redactor,
    ),
    false,
  );
});
