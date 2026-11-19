import { afterEach, expect, test, vi } from 'vitest';
import type { ReplayResponse, WorkerScope } from './replay-engine.js';
import { workflowEvents } from './test-support/events.js';

afterEach(() => vi.unstubAllGlobals());

test('the worker entry attaches the engine to the worker global scope', async () => {
  const posted: ReplayResponse[] = [];
  const scope: WorkerScope = {
    onmessage: null,
    postMessage: (message) => posted.push(message),
  };
  vi.stubGlobal('self', scope);
  await import('./replay.worker.js');
  scope.onmessage!(
    new MessageEvent('message', {
      data: { type: 'append', events: workflowEvents(2) },
    }),
  );
  expect(posted).toEqual([{ type: 'appended', eventCount: 2, lastSeq: 2 }]);
});
