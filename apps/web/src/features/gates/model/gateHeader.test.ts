import { describe, expect, test } from 'vitest';
import { t } from '../../../shared/lib/i18n/index.js';
import { keyT } from '../../../test-support/office/log.js';
import { mainline } from '../../../test-support/office/mainline.js';
import {
  formatWaited,
  gateHeaderViewModel,
  quietState,
  rerunsLeft,
  type GateView,
} from './gateHeader.js';

const tk = keyT as unknown as typeof t;
const log = mainline();
const model = log.at('gate:conclusion');
const now = log.nowAt('gate:conclusion');
const gate = model.gates.find((g) => g.gateId === 'g-conclusion')!;

describe('gateHeaderViewModel', () => {
  test('open conclusion gate: waited, version, reruns, after, quiet office', () => {
    const vm = gateHeaderViewModel(gate, model, { now, t });
    expect(vm.open).toBe(true);
    expect(vm.heading).toBe(t('gates.heading.open', { title: '結論定案' }));
    expect(Object.fromEntries(vm.facts.map((f) => [f.id, f.value]))).toEqual({
      waited: t('office.elapsed.minutesSeconds', { m: 3, s: 12 }),
      version: t('gates.versionValue', { version: 1 }),
      reruns: t('gates.rerunsLeftValue', { count: 2 }),
      after: t('gates.after.meeting'),
    });
    expect(vm.quiet).toEqual({
      clear: true,
      text: t('gates.quiet.clear', { stage: t('stage.meeting'), count: 4 }),
    });
    expect(vm.stageOrdinal).toBe(t('gates.needsStage', { total: 3, index: 1 }));
    expect(vm.rerunsLeft).toBe(2);
    expect(vm.decidedNote).toBeNull();
  });
  test('GitHub-edited version, decided gate, exception gate', () => {
    const edited = {
      ...gate,
      version: 2,
      conclusion: { ...gate.conclusion!, changedOnGithub: true },
    };
    expect(
      gateHeaderViewModel(edited, model, { now, t: tk }).facts[1]!.value,
    ).toBe('gates.versionGithub{"version":2}');
    const decided: GateView = {
      ...gate,
      status: 'approved',
      decision: {
        decision: 'approve',
        by: 'user',
        at: new Date(now - 1000).toISOString(),
      },
    };
    const vm = gateHeaderViewModel(decided, model, {
      now: now + 99_999,
      t: tk,
    });
    expect(vm.open).toBe(false);
    expect(vm.quiet).toBeNull();
    expect(vm.facts[0]!.label).toBe('gates.waitedDecided');
    expect(vm.facts[0]!.value).toBe(
      'office.elapsed.minutesSeconds{"m":3,"s":11}',
    );
    expect(vm.decidedNote).toBe(
      'gates.decidedNote{"status":"gates.status.approved","by":"gates.decidedBy.user"}',
    );
    const closed: GateView = {
      ...gate,
      status: 'closed',
      closedAt: new Date(now).toISOString(),
    };
    expect(
      gateHeaderViewModel(closed, null, { now: now + 1e6, t: tk }).facts[0]!
        .value,
    ).toBe('office.elapsed.minutesSeconds{"m":3,"s":12}');
    const exception: GateView = {
      ...gate,
      kind: 'exception',
      exceptionKind: 'anomaly',
      stageKind: undefined,
    } as GateView;
    const ex = gateHeaderViewModel(exception, model, { now, t: tk });
    expect(ex.facts.map((f) => f.id)).toEqual(['waited', 'version', 'after']);
    expect(ex.facts[2]!.value).toBe('gates.after.exception');
    expect(ex.stageOrdinal).toBeNull();
    expect(ex.quiet).toBeNull();
  });
});

describe('rerunsLeft', () => {
  test('counts reruns and final-PR revisions; null without a stage', () => {
    const meeting = model.stages.find((s) => s.stageId === 'meeting')!;
    const rerun = {
      ...model,
      stages: model.stages.map((s) =>
        s === meeting
          ? {
              ...s,
              runs: [
                ...s.runs,
                { ...s.runs[0]!, attempt: 2, mode: 'rerun' as const },
                { ...s.runs[0]!, attempt: 3, mode: 'rerun' as const },
                { ...s.runs[0]!, attempt: 4, mode: 'rerun' as const },
              ],
            }
          : s,
      ),
    };
    expect(rerunsLeft(gate, rerun)).toBe(0);
    expect(
      gateHeaderViewModel(gate, rerun, { now, t: tk }).facts[2]!.value,
    ).toBe('gates.rerunsNone');
    expect(rerunsLeft(gate, null)).toBeNull();
    expect(rerunsLeft({ ...gate, stageId: 'nope' }, model)).toBeNull();
    const finalStage = model.template.stages.find((s) => s.kind === 'final-pr');
    const finalGate = {
      ...gate,
      stageId: finalStage?.id ?? 'final-pr',
      stageKind: 'final-pr' as const,
    };
    const withFinal = {
      ...model,
      stages: [
        ...model.stages,
        {
          ...meeting,
          stageId: finalGate.stageId,
          kind: 'final-pr' as const,
          runs: [],
        },
      ],
    };
    if (finalStage?.kind === 'final-pr')
      expect(rerunsLeft(finalGate, withFinal)).toBe(finalStage.maxRevisions);
    else expect(rerunsLeft(finalGate, withFinal)).toBeNull();
    expect(
      rerunsLeft(finalGate, {
        ...withFinal,
        template: { ...model.template, stages: [] },
      } as typeof model),
    ).toBeNull();
  });
});

describe('quietState', () => {
  test('lists running agents, or the empty office when nobody took part', () => {
    const alive = log.at('meeting');
    const q = quietState(gate, alive, tk)!;
    expect(q.clear).toBe(false);
    expect(q.text).toContain('gates.quiet.alive');
    expect(quietState({ ...gate, stageId: 'planning' }, model, tk)!.text).toBe(
      'gates.quiet.clearNobody',
    );
    expect(quietState(gate, null, tk)).toBeNull();
  });
});

test('formatWaited', () => {
  expect(formatWaited(tk, 5_000)).toBe('office.elapsed.seconds{"s":5}');
  expect(formatWaited(tk, 15 * 60_000)).toBe('office.elapsed.minutes{"m":15}');
  expect(formatWaited(tk, 2 * 3_600_000)).toBe(
    'office.elapsed.hours{"h":2,"m":0}',
  );
  expect(formatWaited(tk, -1)).toBe('office.elapsed.seconds{"s":0}');
});
