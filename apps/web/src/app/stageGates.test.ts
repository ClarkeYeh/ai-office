import { describe, expect, test } from 'vitest';
import { mainline } from '../test-support/office/mainline.js';
import { stageGateOf } from './stageGates.js';

const log = mainline();

describe('stageGateOf (stage strip gate chips)', () => {
  test('pending before it opens, open with its page, done once decided', () => {
    const atConclusion = log.at('gate:conclusion');
    expect(stageGateOf(atConclusion, 'meeting')).toEqual({
      id: 'conclusion',
      title: '結論定案',
      state: 'open',
      gateId: 'g-conclusion',
      href: '/gates/g-conclusion',
    });
    expect(stageGateOf(atConclusion, 'planning')).toEqual({
      id: 'plan',
      title: '任務拆分',
      state: 'pending',
    });
    const atPlan = log.at('gate:plan');
    expect(stageGateOf(atPlan, 'meeting')?.state).toBe('done');
    expect(stageGateOf(atPlan, 'planning')?.state).toBe('open');
  });
  test('no chip for gate-less stages or gates turned off at start', () => {
    const model = structuredClone(log.at('gate:conclusion'));
    expect(stageGateOf(model, 'implement')).toBeUndefined();
    model.gateToggles = { plan: false };
    expect(stageGateOf(model, 'planning')).toBeUndefined();
  });
  test('a rejected gate is pending again while its stage reruns', () => {
    const model = structuredClone(log.at('gate:plan'));
    model.gates.find((g) => g.gateId === 'g-plan')!.status = 'rejected';
    expect(stageGateOf(model, 'planning')?.state).toBe('pending');
  });
});
