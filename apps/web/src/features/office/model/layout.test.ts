import fc from 'fast-check';
import { replay } from '@ai-office/projection';
import { describe, expect, test } from 'vitest';
import { createLog, keyT, type Log } from '../../../test-support/office/log.js';
import {
  assignDesks,
  hashKey,
  pickDesk,
  placeFor,
  reserveDesks,
  rowsFor,
  sheetsFor,
} from './layout.js';
import { officeViewModel } from './officeViewModel.js';

describe('layout helpers', () => {
  test('hashKey is FNV-1a and stable', () => {
    expect(hashKey('')).toBe(0x811c9dc5);
    expect(hashKey('a')).toBe(0xe40c292c);
    expect(hashKey('feature')).toBe(hashKey('feature'));
  });

  test('pickDesk prefers unused desks, then freed ones, then grows', () => {
    expect(pickDesk(new Set(), new Set(), 3)).toBe(0);
    expect(pickDesk(new Set([0]), new Set([0, 1]), 3)).toBe(2);
    expect(pickDesk(new Set([0]), new Set([0, 1, 2]), 3)).toBe(1);
    expect(pickDesk(new Set([0, 1, 2, 3]), new Set([0, 1, 2, 3]), 3)).toBe(4);
  });

  test('reserveDesks never hands out a held desk and stops at capacity', () => {
    const out = reserveDesks(
      ['a', 'b', 'c'],
      { held: new Set([1]), used: new Set([0, 1]) },
      3,
    );
    expect([...out]).toEqual([
      ['a', 2],
      ['b', 0],
    ]);
  });

  test('rows and sheets', () => {
    expect(rowsFor(0)).toBe(1);
    expect(rowsFor(6)).toBe(2);
    expect(rowsFor(7)).toBe(3);
    expect(rowsFor(3, 3)).toBe(2);
    expect(sheetsFor(-5)).toBe(0);
  });

  test('placeFor by purpose', () => {
    expect(placeFor('worker', undefined, true)).toBe('desk');
    expect(placeFor('worker', undefined, false)).toBe('lounge');
    expect(placeFor('integrator', 'merge', false)).toBe('counter');
    expect(placeFor('participant', undefined, false)).toBe('meeting');
    expect(placeFor('oncall', 'oncall', false)).toBe('lead');
    expect(placeFor(undefined, undefined, true)).toBe('desk');
  });

  test('the first instance of a role wears the default colour; later ones avoid clashes', () => {
    const log = createLog();
    log.stage('implement', 'implement');
    log.items('workitem.approved', [{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
    log
      .tick()
      .dispatch('a', 'a1')
      .tick()
      .dispatch('b', 'b1')
      .tick()
      .dispatch('c', 'c1');
    const { accessories } = assignDesks(log.model, 3);
    const [a, b, c] = ['a', 'b', 'c'].map((k) =>
      accessories.get(`wf1:engineer:${k}`),
    );
    expect(a).toBe('default');
    expect(b).not.toBe(c);
  });

  test('simultaneous starts order by itemKey; meeting chairs by role', () => {
    const log = createLog();
    log.stage('meeting', 'meeting');
    for (const role of ['pm', 'architect'])
      log.spawn({
        attemptId: role,
        role,
        stageId: 'meeting',
        purpose: 'participant',
      });
    log.stage('implement', 'implement');
    log.items('workitem.approved', [{ key: 'b' }, { key: 'a' }]);
    log.tick().dispatch('b', 'b1').dispatch('a', 'a1');
    const vm = officeViewModel(log.model, { now: log.now, t: keyT });
    const by = (id: string) => vm.seats.find((s) => s.seatId === id)!;
    expect(by('wf1:engineer:a').desk).toBe(0);
    expect(by('wf1:engineer:b').desk).toBe(1);
    expect(by('wf1:architect').chair).toBe(0);
    expect(by('wf1:pm').chair).toBe(1);
  });

  test('a released attempt without an end frees its merged desk from its start', () => {
    const log = createLog({ maxParallel: 1 });
    log.stage('implement', 'implement');
    log.items('workitem.approved', [
      { key: 'a' },
      { key: 'b' },
      { key: 'c' },
      { key: 'd' },
    ]);
    for (const key of ['a', 'b', 'c']) {
      log.tick().dispatch(key, `${key}1`);
      log.push('seat.released', {
        attemptId: `${key}1`,
        removeWorkspace: false,
      });
      log.merged(key, 1);
    }
    log.tick().dispatch('d', 'd1');
    // All three fresh desks were used, so d reuses the lowest freed one.
    expect(assignDesks(log.model, 3).desks.get('wf1:engineer:d')).toBe(0);
  });

  test('when every colour is worn, the hashed colour is reused', () => {
    const log = createLog({ maxParallel: 9 });
    log.stage('implement', 'implement');
    const keys = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6'];
    log.items(
      'workitem.approved',
      keys.map((key) => ({ key })),
    );
    for (const key of keys) log.tick().dispatch(key, `${key}-1`);
    const { accessories } = assignDesks(log.model, 9);
    const colours = keys.map((k) => accessories.get(`wf1:engineer:${k}`));
    expect(colours[0]).toBe('default');
    expect(new Set(colours.slice(1, 6)).size).toBe(5);
    expect(colours[6]).toBeDefined();
  });
});

// -- property: stable desks and colours over random lifecycles -----------------

type Phase = 'pending' | 'working' | 'review' | 'rework' | 'done';

/**
 * Drives items through dispatch → PR → queue → review → (merge | rework) or skip,
 * choosing the next action from `choices`. Merges record `pr.status merged` and
 * skips go through a decided exception gate, as the engine does.
 */
function simulate(maxParallel: number, count: number, choices: number[]): Log {
  const log = createLog({ maxParallel });
  log.stage('implement', 'implement');
  const keys = Array.from({ length: count }, (_, i) => `k${i}`);
  log.items(
    'workitem.approved',
    keys.map((key) => ({ key })),
  );
  const phase = new Map<string, Phase>(keys.map((k) => [k, 'pending']));
  const attempt = new Map<string, number>(keys.map((k) => [k, 0]));
  const pr = (key: string) => 100 + keys.indexOf(key);
  const live = (key: string) => `${key}-${attempt.get(key)}`;
  for (const choice of choices) {
    const working = keys.filter((k) => phase.get(k) === 'working').length;
    const actions: (() => void)[] = [];
    for (const key of keys) {
      const p = phase.get(key)!;
      if ((p === 'pending' || p === 'rework') && working < maxParallel)
        actions.push(() => {
          attempt.set(key, attempt.get(key)! + 1);
          log.dispatch(key, live(key), attempt.get(key));
          log.status(live(key), 'working');
          phase.set(key, 'working');
        });
      if (p === 'working')
        actions.push(() => {
          if (attempt.get(key) === 1) log.openPr(key, live(key), pr(key));
          else
            log.itemStatus(key, 'pr_open', {
              attemptId: live(key),
              pr: pr(key),
            });
          log.exit(live(key));
          log.mergeQueued(key, live(key), pr(key));
          log.itemStatus(key, 'in_review');
          phase.set(key, 'review');
        });
      if (p === 'review') {
        actions.push(() => {
          log.merged(key, pr(key));
          phase.set(key, 'done');
        });
        actions.push(() => {
          log.push('workitem.rework_requested', {
            itemKey: key,
            pr: pr(key),
            submissionId: `s-${key}-${attempt.get(key)}`,
            attemptId: 'reviewer',
            reasons: ['again'],
            rework: attempt.get(key)!,
          });
          phase.set(key, 'rework');
        });
      }
      if (p === 'pending' || p === 'rework')
        actions.push(() => {
          const gate = `g-${key}`;
          log.exceptionGate(gate, 'workitem-failed', 'Skip?', { itemKey: key });
          log.decide(gate, 'skip');
          log.itemStatus(key, 'skipped');
          phase.set(key, 'done');
        });
    }
    if (actions.length === 0) break;
    log.tick(1 + (choice % 3));
    actions[choice % actions.length]!();
  }
  return log;
}

describe('desk assignment property (M4_PLAN §3.5)', () => {
  test('an itemKey keeps one desk and colour; live desks never collide; no signal colours', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 2, max: 7 }),
        fc.array(fc.nat(), { minLength: 5, maxLength: 60 }),
        (maxParallel, count, choices) => {
          const log = simulate(maxParallel, count, choices);
          const first = new Map<string, string>();
          for (const rm of log.models) {
            const vm = officeViewModel(rm, { now: 0, t: keyT });
            const live = new Set<number>();
            for (const seat of vm.seats) {
              if (seat.desk === undefined) continue;
              const key = `${seat.desk}/${seat.accessory}`;
              expect(first.get(seat.seatId) ?? key).toBe(key);
              first.set(seat.seatId, key);
              expect([
                'default',
                'cyan',
                'leaf',
                'tan',
                'plum',
                'steel',
              ]).toContain(seat.accessory);
              const item = rm.workItems.find((w) => w.key === seat.itemKey)!;
              const holding =
                !['merged', 'skipped'].includes(item.status) ||
                seat.pose !== 'away';
              if (holding) {
                expect(live.has(seat.desk)).toBe(false);
                live.add(seat.desk);
              }
            }
            // Items waiting in review keep their desks while others work, so held
            // desks may outgrow maxParallel; the floor then grows a row (never shrinks
            // below the template).
            expect(vm.world.rows).toBeGreaterThanOrEqual(rowsFor(maxParallel));
            expect(vm.world.rows * 3).toBeGreaterThan(Math.max(-1, ...live));
            for (const r of vm.reserved) expect(live.has(r.desk)).toBe(false);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  test('replaying to any seq gives the same floor as the live view at that seq', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.nat(), { minLength: 5, maxLength: 40 }),
        fc.nat(),
        (maxParallel, choices, pick) => {
          const log = simulate(maxParallel, 4, choices);
          const seq = 1 + (pick % log.events.length);
          const args = { now: 0, t: keyT };
          expect(officeViewModel(replay(log.events, seq)!, args)).toEqual(
            officeViewModel(log.models[seq - 1]!, args),
          );
        },
      ),
      { numRuns: 30 },
    );
  });
});
