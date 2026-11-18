import { describe, expect, test } from 'vitest';
import { mainline } from '../../../test-support/office/mainline.js';
import { keyT } from '../../../test-support/office/log.js';
import { officeViewModel } from './officeViewModel.js';
import { facingOf } from '../scene/geometry.js';

const log = mainline();
const meeting = log.at('meeting');
const args = { now: log.nowAt('meeting'), t: keyT };
describe('meeting layout and statement bubbles', () => {
  test('participants surround the table, facilitator stands at the head', () => {
    const vm = officeViewModel(meeting, args);
    const pm = vm.seats.find((s) => s.role === 'pm')!;
    const architect = vm.seats.find((s) => s.role === 'architect')!;
    const engineer = vm.seats.find((s) => s.role === 'engineer')!;
    const lead = vm.seats.find((s) => s.role === 'lead')!;
    expect(pm.y).toBe(36);
    expect(architect.y).toBe(36);
    expect(Math.abs(pm.x - architect.x)).toBe(48);
    expect(engineer.y).toBe(72);
    expect(facingOf(engineer)).toBe('back');
    expect(facingOf(pm)).toBe('behind-desk');
    expect(facingOf(lead)).toBe('standing');
    expect(lead.nameplate.y).toBe(73);
    expect(engineer.nameplate.y).toBe(86);
  });
  test('latest current-round statement for the active attempt, translated round context', () => {
    const rm = structuredClone(meeting);
    const stage = rm.stages.find((s) => s.kind === 'meeting')!;
    const original = stage.meeting!.statements.at(-1)!;
    stage.meeting!.statements.push({
      ...original,
      position: 'updated position',
    });
    const vm = officeViewModel(rm, args);
    const seat = vm.seats.find((s) => s.attemptId === original.attemptId)!;
    expect(seat.bubble).toMatchObject({
      position: 'updated position',
      round: 2,
      maxRounds: 2,
    });
    expect(seat.bubble!.label).toContain('office.meeting.bubble');
    const again = officeViewModel(rm, args);
    expect(again).toEqual(vm);
  });
  test('starting a new round clears previous bubbles; concluded and away seats have none', () => {
    const rm = structuredClone(meeting);
    const stage = rm.stages.find((s) => s.kind === 'meeting')!;
    stage.meeting!.round++;
    expect(officeViewModel(rm, args).seats.every((s) => !s.bubble)).toBe(true);
    stage.meeting!.round--;
    stage.meeting!.concluded = true;
    expect(officeViewModel(rm, args).seats.every((s) => !s.bubble)).toBe(true);
    stage.meeting!.concluded = false;
    for (const seat of rm.seats)
      for (const attempt of seat.attempts) attempt.state = 'exited';
    expect(officeViewModel(rm, args).seats.every((s) => !s.bubble)).toBe(true);
  });
  test('a new attempt cannot inherit its predecessor’s statement', () => {
    const rm = structuredClone(meeting);
    rm.seats.forEach((seat) => {
      seat.currentAttemptId = 'new-attempt';
    });
    expect(officeViewModel(rm, args).seats.every((s) => !s.bubble)).toBe(true);
  });
});
