import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { commandId } from './context.js';
import { runMeeting, type Scenario } from './test-support/meeting.js';

// The marker guards: runtime-orca refuses whitespace, scm-github also `<>`.
const markerSafe = /^[^\s<>]+$/;

describe('commandId', () => {
  it('percent-encodes characters the external marker guards refuse', () => {
    expect(commandId({ workflowId: 'wf' }, 'nudge', 'round 1', 'a<b>')).toBe(
      'wf/nudge/round%201/a%3Cb%3E',
    );
    expect(commandId({ workflowId: 'wf' }, 'stage', 2, 'x:y-z')).toBe(
      'wf/stage/2/x:y-z',
    );
  });
  it('pins existing ids without % (stable across the FX-TAIL change)', () => {
    const wf = { workflowId: 'wf' };
    expect(commandId(wf, 'nudge', 'round 1', 'a<b>')).toBe(
      'wf/nudge/round%201/a%3Cb%3E',
    );
    expect(commandId(wf, 'stage', 2, 'x:y-z')).toBe('wf/stage/2/x:y-z');
    expect(commandId(wf, 'nudge', 'round-1', 'pm')).toBe('wf/nudge/round-1/pm');
    expect(commandId(wf, 'cleanup', 'a\tb\nc')).toBe('wf/cleanup/a%09b%0Ac');
    expect(commandId(wf, 'a\u00a0b')).toBe('wf/a%A0b');
  });
  it('is injective: % is escaped first, wide whitespace as UTF-8 (FX-TAIL)', () => {
    const wf = { workflowId: 'wf' };
    // Before: the literal 'a%20b' and 'a b' were both 'a%20b'; U+2028 and
    // ' 28' were both '%2028'.
    expect(commandId(wf, 'a%20b')).toBe('wf/a%2520b');
    expect(commandId(wf, 'a b')).toBe('wf/a%20b');
    expect(commandId(wf, '\u2028')).toBe('wf/%E2%80%A8');
    expect(commandId(wf, ' 28')).toBe('wf/%2028');
    const part = fc.string({
      unit: fc.constantFrom(
        ...['a', 'A', '0', '2', '8', 'E', '-', ':', '%', ' ', '\t', '<', '>'],
        ...['\u00a0', '\u0085', '\u2028', '\u3000'],
      ),
    });
    fc.assert(
      fc.property(part, part, (a, b) => {
        const [x, y] = [a, b].map((p) => commandId(wf, p));
        expect(x === y).toBe(a === b);
        expect(x).toMatch(markerSafe);
      }),
    );
  });
  it('keeps ids without % or wide whitespace byte-identical to before', () => {
    const previous = (p: string) =>
      p.replace(
        /[\s<>]/g,
        (c) =>
          `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
      );
    const unit = fc.oneof(
      fc.constantFrom(' ', '\t', '\n', '<', '>', '\u00a0', '\u0085'),
      fc.string({ minLength: 1, maxLength: 1 }),
    );
    fc.assert(
      fc.property(
        fc
          .string({ unit })
          .filter(
            (p) =>
              !/[%/]/.test(p) && [...p].every((c) => c.charCodeAt(0) <= 0xff),
          ),
        (p) => {
          expect(commandId({ workflowId: 'wf' }, p)).toBe(`wf/${previous(p)}`);
        },
      ),
    );
  });
});

describe('engine runtime command ids', () => {
  it.each<Scenario>([
    {},
    { early: true, absent: ['pm'] },
    { absent: ['pm', 'architect'] },
    { missingConclusion: true },
    { missingAgenda: true },
    { planning: true, missingItems: true },
  ])('pass the external marker guard (%j)', (options) => {
    // Reminders (round timeouts, missing output) included: T12 found
    // `nudge/round 1/…`, which Orca refused.
    const sim = runMeeting(options)
      .advance(5 * 60_000)
      .advance(20 * 60_000);
    const ids = sim
      .eventsOf('command.issued')
      .map((e) => e.payload.commandId as string);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => !markerSafe.test(id))).toEqual([]);
  });
  it('slugs the meeting round in the reminder id, not in its text', () => {
    const sim = runMeeting({ early: true, absent: ['pm'] }).advance(5 * 60_000);
    const nudges = sim
      .eventsOf('command.issued')
      .filter((e) => String(e.payload.commandId).includes('/nudge/'));
    expect(nudges.map((e) => e.payload.commandId)).toEqual(
      expect.arrayContaining([expect.stringContaining('/nudge/round-1/')]),
    );
    expect(sim.eventsOf('message.nudge').map((e) => e.payload.body)).toContain(
      'Missing round 1 output or worker_done',
    );
  });
});
