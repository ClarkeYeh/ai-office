import { officeViewModel } from '../../features/office/model/index.js';
import type { OfficeViewModel } from '../../features/office/model/index.js';
import { createLog, zhT, type Log } from '../office/log.js';
import { mainline } from '../office/mainline.js';

// View-model fixtures for the scene harness (M4_PLAN §7.1 visual regression, 2×):
// built from event logs through the real office model, so they stay in step
// with it. Six states plus the perf floor; ids are stable for e2e.

export const HARNESS_STATES = [
  'implement',
  'meeting',
  'conclusion-hush',
  'two-rows',
  'error-needs-you',
  'final-merged',
] as const;
export type HarnessState = (typeof HARNESS_STATES)[number];

const at = (log: Log, mark: string, selectedSeatId?: string) =>
  officeViewModel(log.at(mark), {
    now: log.nowAt(mark),
    t: zhT,
    ...(selectedSeatId === undefined ? {} : { selectedSeatId }),
  });

/** Planning approved `keys`, then the implement stage starts. */
function implementLog(maxParallel: number, keys: string[]) {
  const log = createLog({ maxParallel });
  log.tick(5).stage('planning', 'planning');
  log.items(
    'workitem.proposed',
    keys.map((key) => ({ key })),
  );
  log.items(
    'workitem.approved',
    keys.map((key) => ({ key })),
  );
  log.stageDone('planning');
  log.tick(5).stage('implement', 'implement');
  return log;
}

/**
 * Implement with every pose (§2.6) and repeated engineers in different
 * accessory colours: working (edit), idle, error, needs-you (on-call lead) and
 * away (the integrator after its review).
 */
function implementFloor(): OfficeViewModel {
  const log = implementLog(3, ['feature', 'persist', 'theme']);
  log.tick().dispatch('feature', 'f-1').status('f-1', 'working');
  log.tick().dispatch('persist', 'p-1').status('p-1', 'working');
  log.tick().dispatch('theme', 't-1').status('t-1', 'working');
  log.tick(30).activity('f-1', 'edit').activity('p-1', 'shell');
  log.tokens('f-1', 220_000).tokens('p-1', 148_000).tokens('t-1', 60_000);
  log.tick(20).status('p-1', 'idle');
  log.tick(20).status('t-1', 'error');
  log.tick().spawn({
    attemptId: 'int-1',
    role: 'integrator',
    stageId: 'implement',
    purpose: 'integrator',
    ondemand: 'merge',
  });
  log.status('int-1', 'working').tick(30).exit('int-1');
  log.tick(20).spawn({
    attemptId: 'lead-oc',
    role: 'lead',
    stageId: 'implement',
    purpose: 'oncall',
    ondemand: 'oncall',
  });
  log.status('lead-oc', 'waiting_input');
  log.tick(30).mark('implement');
  return at(log, 'implement');
}

/** maxParallel 6: two desk rows, five engineers working, one desk reserved. */
function twoRows(): OfficeViewModel {
  const keys = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
  const log = implementLog(6, keys);
  const tools = ['edit', 'shell', 'read', 'git', 'network'] as const;
  keys.slice(0, 5).forEach((key, i) => {
    log.tick().dispatch(key, `${key}-1`).status(`${key}-1`, 'working');
    log.activity(`${key}-1`, tools[i]!);
    log.tokens(`${key}-1`, 50_000 * (i + 1));
  });
  log.tick(30).mark('rows');
  return at(log, 'rows');
}

/**
 * An error at one desk, a question waiting at another, an open exception gate on
 * your desk, and a PR under review at the counter with one more queued.
 */
function errorNeedsYou(): OfficeViewModel {
  const log = implementLog(3, ['feature', 'persist', 'theme']);
  log.tick().dispatch('feature', 'f-1').status('f-1', 'working');
  log.tick().dispatch('persist', 'p-1').status('p-1', 'working');
  log.tick().dispatch('theme', 't-1').status('t-1', 'working');
  log.tick(30).openPr('theme', 't-1', 4).exit('t-1');
  log.mergeQueued('theme', 't-1', 4).queue(['theme']);
  log.tick().spawn({
    attemptId: 'int-1',
    role: 'integrator',
    stageId: 'implement',
    purpose: 'integrator',
    ondemand: 'merge',
  });
  log.status('int-1', 'working');
  log.queue([], 'theme').itemStatus('theme', 'in_review', { attemptId: 't-1' });
  log.tick(60).status('f-1', 'error');
  log.tick(30).status('p-1', 'waiting_input');
  log.exceptionGate('g-ex', 'merge-blocked', 'PR #4 無法合併', {});
  log.tick(45).mark('trouble');
  return at(log, 'trouble', 'wf1:engineer:persist');
}

let cache: Record<HarnessState, OfficeViewModel> | undefined;
export function harnessFixtures(): Record<HarnessState, OfficeViewModel> {
  if (cache) return cache;
  const main = mainline();
  cache = {
    implement: implementFloor(),
    meeting: at(main, 'meeting'),
    'conclusion-hush': at(main, 'gate:conclusion'),
    'two-rows': twoRows(),
    'error-needs-you': errorNeedsYou(),
    'final-merged': at(main, 'end'),
  };
  return cache;
}

/**
 * Perf floor (M4_PLAN §7.1, N9): `count` seats typing at once (each a 2-frame
 * transform strip), on as many desk rows as that needs.
 */
export function perfFloor(count: number): OfficeViewModel {
  const keys = Array.from({ length: count }, (_, i) => `item-${i}`);
  const log = implementLog(count, keys);
  const tools = ['edit', 'shell', 'read', 'git', 'network'] as const;
  keys.forEach((key, i) => {
    log.tick().dispatch(key, `a-${i}`).status(`a-${i}`, 'working');
    log.activity(`a-${i}`, tools[i % tools.length]!);
  });
  log.tick(10).mark('perf');
  return at(log, 'perf');
}
