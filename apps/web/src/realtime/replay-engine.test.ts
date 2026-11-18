import { afterEach, expect, test, vi } from 'vitest';
import fc from 'fast-check';
import {
  CHECKPOINT_INTERVAL,
  createCheckpoints,
  replay,
} from '@ai-office/projection';
import {
  attachReplayEngine,
  createReplayEngine,
  type ReplayResponse,
  type WorkerScope,
} from './replay-engine.js';
import { healthChanged, workflowEvents } from './test-support/events.js';

afterEach(() => vi.useRealTimers());

const events = workflowEvents(CHECKPOINT_INTERVAL * 2 + 40, 'wf1', 3, 2);
const expectedCheckpoints = createCheckpoints(events);

/*
 * The property tests' cost is fixed by their bounds, not by chance: every run
 * replays the same 1,040-event stream (at most 8 appends, or one replay to a
 * seq within it). Locally each test takes ~0.5-0.9 s with or without coverage;
 * the default 5 s timeout was exceeded only on a loaded shared machine, so they
 * get 6x that headroom instead of fewer runs or a smaller stream.
 */
const PROPERTY_TIMEOUT_MS = 30_000;

test(
  'incremental checkpoints equal createCheckpoints over the whole stream',
  {
    timeout: PROPERTY_TIMEOUT_MS,
  },
  () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 400 }), { maxLength: 8 }),
        (sizes) => {
          const engine = createReplayEngine();
          let offset = 0;
          for (const size of sizes) {
            engine.append(events.slice(offset, offset + size));
            offset += size;
          }
          engine.append(events.slice(offset));
          expect(engine.checkpoints).toEqual(expectedCheckpoints);
          expect(engine.eventCount).toBe(events.length);
          expect(engine.lastSeq).toBe(events.at(-1)!.seq);
        },
      ),
      { numRuns: 15 },
    );
  },
);

test(
  'query(N) equals replay to N, at any position including gaps',
  {
    timeout: PROPERTY_TIMEOUT_MS,
  },
  () => {
    const engine = createReplayEngine();
    expect(engine.lastSeq).toBe(0);
    expect(engine.query(10)).toBeNull();
    // Duplicates and events that do not start a workflow are ignored.
    engine.append([healthChanged(1), ...events, events[5]!]);
    expect(engine.eventCount).toBe(events.length + 1);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: events.at(-1)!.seq + 5 }),
        (seq) => {
          expect(engine.query(seq)).toEqual(replay(events, seq));
        },
      ),
      { numRuns: 60 },
    );
  },
);

test('the worker scope answers appends and only the newest pending seek', () => {
  vi.useFakeTimers();
  const posted: ReplayResponse[] = [];
  const scope: WorkerScope = {
    onmessage: null,
    postMessage: (message) => posted.push(message),
  };
  attachReplayEngine(scope);
  const send = (
    data: Parameters<NonNullable<WorkerScope['onmessage']>>[0]['data'],
  ) => scope.onmessage!(new MessageEvent('message', { data }));
  send({ type: 'append', events: events.slice(0, 10) });
  expect(posted).toEqual([
    { type: 'appended', eventCount: 10, lastSeq: events[9]!.seq },
  ]);
  send({ type: 'seek', id: 1, seq: 5 });
  send({ type: 'seek', id: 2, seq: 7 });
  send({ type: 'seek', id: 3, seq: 9 });
  vi.runAllTimers();
  expect(posted.slice(1)).toEqual([
    { type: 'result', id: 3, seq: 9, model: replay(events, 9) },
  ]);
  send({ type: 'seek', id: 4, seq: 3 });
  vi.runAllTimers();
  expect(posted.at(-1)).toMatchObject({ type: 'result', id: 4, seq: 3 });
});
