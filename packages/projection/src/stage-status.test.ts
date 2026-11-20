import { expect, test } from 'vitest';
import { replay } from './index.js';
import { payloads } from './test-support/events.js';
import { scenario } from './test-support/scenario.js';

// FX11: stage status after a gate settles mirrors domain evolve (§4).
function gatedMeeting() {
  const s = scenario();
  s.push('stage.started');
  s.push('stage.completed');
  s.push('gate.opened');
  expect(s.model.stages[0]?.status).toBe('awaiting_gate');
  return s;
}
const decide = (decision: 'approve' | 'revise' | 'reject') => ({
  gateId: 'g1',
  decision,
  by: 'user',
  version: 1,
});

test('approving or revising a stage gate moves the stage to done', () => {
  for (const decision of ['approve', 'revise'] as const) {
    const s = gatedMeeting();
    s.push('gate.decided', decide(decision));
    expect(s.model.stages[0]?.status).toBe('done');
    expect(replay(s.events)).toEqual(s.model);
  }
});

test('rejecting keeps the stage awaiting_gate until the rerun starts it running', () => {
  const s = gatedMeeting();
  s.push('gate.decided', decide('reject'));
  expect(s.model.stages[0]?.status).toBe('awaiting_gate');
  s.push('stage.rerun_requested', {
    stageId: 'meeting',
    fromAttempt: 1,
    mode: 'rerun',
    by: 'user',
    gateId: 'g1',
  });
  expect(s.model.stages[0]?.status).toBe('awaiting_gate');
  s.push('stage.started', {
    ...payloads['stage.started'],
    attempt: 2,
    mode: 'rerun',
  });
  expect(s.model.stages[0]?.status).toBe('running');
  expect(s.model.stages[0]?.gateId).toBeUndefined();
  expect(replay(s.events)).toEqual(s.model);
});

test('the final-pr gate closing on merge moves the stage to done; other closes do not', () => {
  for (const [reason, status] of [
    ['merged', 'done'],
    ['cancelled', 'awaiting_gate'],
  ] as const) {
    const s = scenario();
    s.push('stage.started', {
      stageId: 'final-pr',
      kind: 'final-pr',
      attempt: 1,
      mode: 'initial',
    });
    s.push('stage.completed', { stageId: 'final-pr', attempt: 1 });
    s.push('gate.opened', {
      gateId: 'gf',
      stageId: 'final-pr',
      kind: 'stage',
      templateGateId: 'final-pr',
      stageKind: 'final-pr',
      optional: false,
      title: 'Final PR',
      options: [],
      content: { type: 'final-pr', artifactId: 'art9', pr: 9 },
      version: 1,
    });
    const stage = () => s.model.stages.find((x) => x.stageId === 'final-pr');
    expect(stage()?.status).toBe('awaiting_gate');
    s.push('gate.closed', { gateId: 'gf', reason });
    expect(stage()?.status).toBe(status);
    expect(replay(s.events)).toEqual(s.model);
  }
});

test('a final PR closed unmerged marks its open gate (prClosedAt) and narrows the options (S9)', () => {
  const s = scenario();
  s.push('stage.started', {
    stageId: 'final-pr',
    kind: 'final-pr',
    attempt: 1,
    mode: 'initial',
  });
  s.push('stage.completed', { stageId: 'final-pr', attempt: 1 });
  s.push('gate.opened', {
    gateId: 'gf',
    stageId: 'final-pr',
    kind: 'stage',
    templateGateId: 'final-pr',
    stageKind: 'final-pr',
    optional: false,
    title: 'Final PR',
    options: ['request-changes', 'keep-open', 'abort'].map((optionId) => ({
      optionId,
      label: optionId,
    })),
    content: { type: 'final-pr', artifactId: 'art9', pr: 9 },
    version: 1,
  });
  const status = (state: 'closed' | 'open') =>
    s.push('pr.status', {
      pr: 9,
      state,
      base: 'main',
      head: 'ai-office/x',
      headSha: 'abcdef1',
      mergeable: true,
    });
  const gate = () => s.model.gates.find((g) => g.gateId === 'gf')!;
  status('closed');
  expect(gate().status).toBe('open');
  expect(gate().content).toMatchObject({ prClosedAt: expect.any(String) });
  expect(gate().options.map((o) => o.optionId)).toEqual(['keep-open', 'abort']);
  expect(replay(s.events)).toEqual(s.model);
  status('open');
  expect(gate().content).not.toHaveProperty('prClosedAt');
  expect(gate().options.map((o) => o.optionId)).toEqual([
    'request-changes',
    'keep-open',
    'abort',
  ]);
  expect(replay(s.events)).toEqual(s.model);
});
