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
