import { readFileSync } from 'node:fs';
import type { DomainEvent, EventPayload } from '@ai-office/contracts/events';
import type { ReadModel } from '@ai-office/projection';
import { describe, expect, test } from 'vitest';
import {
  boardViewModel,
  officeViewModel,
} from '../../features/office/model/index.js';
import { gateHeaderViewModel } from '../../features/gates/model/index.js';
import { createReplayEngine } from '../../realtime/replay-engine.js';
import { t } from '../../shared/lib/i18n/index.js';
import { keyT } from './log.js';
import {
  M5_JOINT_FIXTURE,
  PLACEHOLDER,
  M5_JOINT_RESTART_SEQ,
  foldJointExport,
  parseJointExport,
  type JointLog,
} from './m5-joint.js';

// Reads the fixture from disk; kept in the test file, which has Node types
// (the web app's own tsconfig does not, M5-T17).
function loadJointLog(
  url: URL = M5_JOINT_FIXTURE,
  restartSeq = M5_JOINT_RESTART_SEQ,
): JointLog {
  return foldJointExport(
    parseJointExport(readFileSync(url, 'utf8')),
    restartSeq,
  );
}

// M5-T17 CI replay of the masked joint-run export (M5_PLAN §5 T17, §6.1).
// Semantics only: seat poses, needs, board columns, gate headers and replay =
// live fold. Every expectation is derived from the events themselves, so T12's
// real export replaces the T9-derived placeholder without touching this file.

const log = loadJointLog();
const { events, models } = log;
const nowAt = (index: number) => Date.parse(events[index]!.recordedAt);
const office = (index: number) =>
  officeViewModel(models[index]!, { now: nowAt(index), t: keyT });
const indexOf = (seq: number) => events.findIndex((e) => e.seq === seq);
const ofType = <T extends DomainEvent['type']>(type: T) =>
  events.filter((e): e is Extract<DomainEvent, { type: T }> => e.type === type);
const seatOfAttempt = (rm: ReadModel, attemptId: string) =>
  rm.seats.find((s) => s.attempts.some((a) => a.attemptId === attemptId));
const final = models.at(-1)!;
const finalIndex = events.length - 1;

describe('M5-T17 joint replay: fixtures/web/m5-joint.events.json', () => {
  test('one masked workflow that ran to completion', () => {
    expect(final.status).toBe('completed');
    expect(final.lastSeq).toBe(events.at(-1)!.seq);
    expect(office(finalIndex).door.open).toBe(true);
    // Masked: agent free text is a placeholder, never the original.
    expect(
      ofType('meeting.statement').every((e) =>
        PLACEHOLDER.test(
          (e.payload as EventPayload<'meeting.statement'>).statement.position,
        ),
      ),
    ).toBe(true);
  });

  test('every spawned agent appears in the office from its spawn to the end', () => {
    const spawned = ofType('seat.spawned');
    expect(spawned.length).toBeGreaterThan(0);
    for (const e of spawned) {
      const seats = office(indexOf(e.seq)).seats;
      const seat = seats.find((s) => s.seatId === e.payload.seatId);
      expect(seat, `seat at seq ${e.seq}`).toBeDefined();
      expect(seat!.vendor).toBe(e.payload.agent);
      expect(seat!.role).toBe(e.payload.role);
    }
    const ids = new Set(spawned.map((e) => e.payload.seatId));
    expect(new Set(office(finalIndex).seats.map((s) => s.seatId))).toEqual(ids);
  });

  test('at each waiting_input seq that seat waits and needs you', () => {
    const waiting = ofType('seat.status').filter(
      (e) => e.payload.state === 'waiting_input',
    );
    expect(waiting.length).toBeGreaterThan(0);
    for (const e of waiting) {
      const index = indexOf(e.seq);
      const seatId = seatOfAttempt(models[index]!, e.payload.attemptId)!.seatId;
      const vm = office(index);
      expect(
        vm.seats.find((s) => s.seatId === seatId),
        `seat at seq ${e.seq}`,
      ).toMatchObject({
        pose: 'needs-you',
        state: 'waiting_input',
        needsYou: true,
        attemptId: e.payload.attemptId,
      });
      expect(vm.needs.map((n) => n.id)).toContain(`seat:${seatId}`);
    }
    // Nobody is still waiting at the end.
    expect(office(finalIndex).seats.filter((s) => s.needsYou)).toEqual([]);
  });

  // ~1 s locally; headroom for the shared machine and coverage.
  test(
    'replay equals the live fold at every gate, every wait, around the restart and at the end',
    { timeout: 30_000 },
    () => {
      const restart = indexOf(log.restartSeq);
      expect(restart).toBeGreaterThan(0);
      expect(restart).toBeLessThan(finalIndex);
      // A full every-seq comparison is quadratic (each query folds up to one
      // checkpoint interval); this covers each state change the UI evidence
      // checks plus an even spread.
      const step = Math.max(1, Math.floor(events.length / 40));
      const chosen = new Set(
        events.flatMap((e, index) =>
          e.type === 'gate.opened' ||
          e.type === 'seat.status' ||
          e.type === 'seat.spawned' ||
          Math.abs(index - restart) <= 3 ||
          index % step === 0 ||
          index === finalIndex
            ? [index]
            : [],
        ),
      );
      // Paged like the browser's replay worker (500 per page).
      const engine = createReplayEngine();
      for (let i = 0; i < events.length; i += 500)
        engine.append(events.slice(i, i + 500));
      expect(engine.lastSeq).toBe(final.lastSeq);
      for (const index of chosen) {
        const seq = events[index]!.seq;
        expect(engine.query(seq), `seq ${seq}`).toEqual(models[index]);
      }

      // Continuity: the restart point lies inside the log with events on both
      // sides, no event is recorded twice, and the read model moves forward
      // through it without losing a seat or a work item.
      expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
      for (let i = 1; i < events.length; i++) {
        const before = models[i - 1]!;
        const after = models[i]!;
        expect(after.lastSeq).toBe(events[i]!.seq);
        expect(after.seats.length).toBeGreaterThanOrEqual(before.seats.length);
        expect(after.workItems.length).toBeGreaterThanOrEqual(
          before.workItems.length,
        );
      }
      const seatIds = (index: number) =>
        office(index).seats.map((s) => s.seatId);
      expect(seatIds(restart + 1)).toEqual(
        expect.arrayContaining(seatIds(restart - 1)),
      );
    },
  );

  test('token usage is a number that never drops, and the budget is disabled', () => {
    let previous = 0;
    for (const index of events.keys()) {
      const { usage } = office(index);
      expect(Number.isSafeInteger(usage.totalTokens)).toBe(true);
      expect(usage.totalTokens).toBeGreaterThanOrEqual(previous);
      previous = usage.totalTokens;
    }
    const usage = office(finalIndex).usage;
    expect(usage.totalTokens).toBe(final.usage.total.budgetTokens);
    expect(usage).toMatchObject({
      budgetDisabled: true,
      budgetLabel: 'office.usage.budgetDisabled',
    });
  });

  test('the board ends with every approved item merged', () => {
    const approved = ofType('workitem.approved').at(-1)!.payload.items;
    const board = boardViewModel(final, { now: nowAt(finalIndex), t: keyT });
    const merged = board.columns.find((c) => c.id === 'merged')!;
    expect(merged.cards.map((c) => c.itemKey).sort()).toEqual(
      approved.map((i) => i.key).sort(),
    );
    for (const column of board.columns.filter((c) => c.id !== 'merged'))
      expect(column.cards, column.id).toEqual([]);
  });

  test('every gate has a gate page header, open at its opening seq and settled at the end', () => {
    const opened = ofType('gate.opened');
    expect(opened.length).toBeGreaterThan(0);
    const tk = keyT as unknown as typeof t;
    for (const e of opened) {
      const index = indexOf(e.seq);
      const gate = models[index]!.gates.find(
        (g) => g.gateId === e.payload.gateId,
      )!;
      expect(gate.status).toBe('open');
      const header = gateHeaderViewModel(gate, models[index]!, {
        now: nowAt(index),
        t: tk,
      });
      expect(header.gateId).toBe(e.payload.gateId);
      expect(office(index).needs.map((n) => n.id)).toContain(
        `gate:${e.payload.gateId}`,
      );
    }
    for (const gate of final.gates) expect(gate.status).not.toBe('open');
  });
});

describe('M5-T17 joint export loader', () => {
  const text = JSON.stringify({
    exportedAt: '2000-01-01T00:00:00.000Z',
    aiOfficeCommit: 'a'.repeat(40),
    orcaVersion: '1.2.3',
    events: events.slice(0, 3),
  });

  test('reads the committed fixture and swaps restart seqs', () => {
    expect(M5_JOINT_FIXTURE.pathname).toMatch(
      /\/fixtures\/web\/m5-joint\.events\.json$/,
    );
    const short = foldJointExport(parseJointExport(text), 7);
    expect(short.restartSeq).toBe(7);
    expect(short.models).toHaveLength(3);
    expect(short.modelAt(Number.MAX_SAFE_INTEGER)).toBe(short.models[2]);
    expect(() => short.modelAt(0)).toThrow(/No event/);
  });

  test.each([
    ['unmasked', (d: Record<string, unknown>) => ({ ...d, exportedAt: 'now' })],
    [
      'bad commit',
      (d: Record<string, unknown>) => ({ ...d, aiOfficeCommit: 'x' }),
    ],
    ['no events', (d: Record<string, unknown>) => ({ ...d, events: null })],
    [
      'seq out of order',
      (d: Record<string, unknown>) => ({
        ...d,
        events: [...(d.events as unknown[])].reverse(),
      }),
    ],
    [
      'unknown type',
      (d: Record<string, unknown>) => ({
        ...d,
        events: (d.events as DomainEvent[]).map((e, i) =>
          i === 1 ? { ...e, type: 'nope' } : e,
        ),
      }),
    ],
    [
      'second workflow',
      (d: Record<string, unknown>) => ({
        ...d,
        events: (d.events as DomainEvent[]).map((e, i) =>
          i === 2 ? { ...e, workflowId: 'other' } : e,
        ),
      }),
    ],
    [
      'no workflow.started',
      (d: Record<string, unknown>) => ({
        ...d,
        events: (d.events as DomainEvent[]).slice(1),
      }),
    ],
  ])('rejects %s', (_, change) => {
    const data = JSON.parse(text) as Record<string, unknown>;
    expect(() => parseJointExport(JSON.stringify(change(data)))).toThrow();
  });
});
