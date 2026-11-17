import { EVENT_TYPES } from '@ai-office/contracts/events';
import type { DomainEvent, EventType } from '@ai-office/contracts/events';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { evolve, evolveWithWarning, replay } from './evolve.js';
import { initialState } from './state/index.js';
import {
  at,
  eventDraft,
  startCommand,
  toEvent,
} from './test-support/fixtures.js';
import { decide } from './decide/index.js';
import { samplePayloads } from './test-support/samples.js';
import type { SampleIds } from './test-support/samples.js';

const pick = (values: string[]) => fc.constantFrom(...values);

/** Small id pools so generated events actually collide with each other. */
const idsArb: fc.Arbitrary<SampleIds> = fc.record({
  stageId: pick([
    'meeting',
    'breakdown',
    'implement',
    'integrate',
    'final-pr',
    'ghost',
  ]),
  attemptId: pick(['att-1', 'att-2', 'att-3']),
  gateId: pick(['conclusion', 'task-split', 'exc-1']),
  itemKey: pick(['item-a', 'item-b']),
  questionId: pick(['q-1', 'q-2']),
  commandId: pick(['cmd-att-1', 'cmd-att-2', 'cmd-x']),
  timerId: pick(['t-1', 't-2']),
  submissionId: pick(['sub-1', 'sub-2']),
  artifactId: pick(['art-1', 'art-2']),
  seatId: pick(['wf-1:pm', 'wf-1:lead']),
  n: fc.integer({ min: 1, max: 4 }),
});

/** Schema-valid events with random ids, envelopes, order and unknown extra fields. */
const plausibleEvent: fc.Arbitrary<Omit<DomainEvent, 'seq' | 'id'>> = fc
  .record({
    type: fc.constantFrom(...EVENT_TYPES),
    ids: idsArb,
    workflowId: fc.constantFrom<string | null>(
      'wf-1',
      'wf-1',
      'wf-1',
      'wf-2',
      null,
    ),
    second: fc.integer({ min: 0, max: 10_000 }),
    extra: fc.dictionary(fc.string({ maxLength: 4 }), fc.jsonValue(), {
      maxKeys: 2,
    }),
  })
  .map(({ type, ids, workflowId, second, extra }) => {
    const draft = eventDraft(type, samplePayloads(ids)[type] as never, {
      second,
      workflowId,
    });
    return {
      ...draft,
      ...{ payload: { ...draft.payload, ...extra } },
      recordedAt: at(second),
    } as Omit<DomainEvent, 'seq' | 'id'>;
  });

const started = (): DomainEvent => {
  const result = decide(initialState(), startCommand());
  if (!result.ok) throw new Error('start failed');
  return toEvent(result.events[0] as never, 1);
};

const sequence = (drafts: Omit<DomainEvent, 'seq' | 'id'>[]): DomainEvent[] => [
  started(),
  ...drafts.map((draft, i) => toEvent(draft as never, i + 2)),
];

describe('evolve is total', () => {
  test('arbitrary junk never throws', () => {
    const junkEvent = fc.oneof(
      fc.anything(),
      fc.record({
        type: fc.oneof(fc.constantFrom<string>(...EVENT_TYPES), fc.string()),
        seq: fc.oneof(fc.integer(), fc.double(), fc.constant(undefined)),
        workflowId: fc.oneof(
          fc.constant('wf-1'),
          fc.constant(null),
          fc.anything(),
        ),
        payload: fc.oneof(fc.object(), fc.anything()),
      }),
    );
    fc.assert(
      fc.property(fc.array(junkEvent, { maxLength: 30 }), (events) => {
        let state = evolve(initialState(), started());
        for (const event of events) state = evolve(state, event as DomainEvent);
        expect(state.workflowId).toBe('wf-1');
      }),
      { numRuns: 300 },
    );
  });

  test('schema-valid events in any order never hit a handler error', () => {
    fc.assert(
      fc.property(fc.array(plausibleEvent, { maxLength: 60 }), (drafts) => {
        const events = sequence(drafts);
        let state = initialState();
        let lastSeq = 0;
        for (const event of events) {
          const result = evolveWithWarning(state, event);
          expect(result.warning?.code).not.toBe('handler_error');
          expect(result.state.lastSeq).toBeGreaterThanOrEqual(lastSeq);
          lastSeq = result.state.lastSeq;
          state = result.state;
        }
        expect(state.lastSeq).toBe(events.length);
        expect(JSON.parse(JSON.stringify(state))).toEqual(state);
      }),
      { numRuns: 300 },
    );
  });

  test('shuffled seq (out-of-order delivery) is skipped, never thrown', () => {
    fc.assert(
      fc.property(
        fc
          .array(plausibleEvent, { maxLength: 30 })
          .chain((drafts) =>
            fc.shuffledSubarray(sequence(drafts), { minLength: 0 }),
          ),
        (events) => {
          const { state, warnings } = replay(events);
          expect(warnings.map((w) => w.code)).not.toContain('handler_error');
          // The highest seq is always consumed whenever it arrives.
          expect(state.lastSeq).toBe(Math.max(0, ...events.map((e) => e.seq)));
        },
      ),
      { numRuns: 200 },
    );
  });

  test('replay is deterministic and chunking does not matter', () => {
    fc.assert(
      fc.property(
        fc.array(plausibleEvent, { maxLength: 40 }),
        fc.nat(),
        (drafts, cut) => {
          const events = sequence(drafts);
          const split = cut % (events.length + 1);
          const whole = replay(events).state;
          const first = replay(events.slice(0, split)).state;
          expect(replay(events.slice(split), first).state).toEqual(whole);
          expect(replay(events).state).toEqual(whole);
        },
      ),
      { numRuns: 200 },
    );
  });
});

test('every event type is generated by the plausible arbitrary', () => {
  const seen = new Set<EventType>();
  fc.assert(
    fc.property(plausibleEvent, (event) => {
      seen.add(event.type);
    }),
    { numRuns: 2000, seed: 1 },
  );
  expect(seen.size).toBe(EVENT_TYPES.length);
});
