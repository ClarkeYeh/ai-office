import type { WorkflowSummary } from '@ai-office/contracts/api';
import { EVENT_TYPES } from '@ai-office/contracts/events';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  createOverviewRefresher,
  OVERVIEW_DEBOUNCE_MS,
  overviewPartsFor,
} from './overview.js';
import { createWebStore } from './store.js';
import { apiError, createFakeServer, health } from './test-support/fakes.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('signal events map to the endpoints they invalidate (§3.4)', () => {
  expect(overviewPartsFor('gate.opened')).toEqual(['gates', 'workflows']);
  expect(overviewPartsFor('gate.closed')).toEqual(['gates', 'workflows']);
  expect(overviewPartsFor('message.escalated')).toEqual([
    'questions',
    'workflows',
  ]);
  expect(overviewPartsFor('message.answered')).toEqual([
    'questions',
    'workflows',
  ]);
  expect(overviewPartsFor('workflow.paused')).toEqual(['workflows']);
  expect(overviewPartsFor('stage.completed')).toEqual(['workflows']);
  expect(overviewPartsFor('usage.tokens')).toEqual(['workflows']);
  expect(overviewPartsFor('health.changed')).toEqual(['health']);
  expect(overviewPartsFor('runtime.identity_hijacked')).toEqual(['health']);
  expect(overviewPartsFor('repo.updated')).toEqual(['repos']);
  const silent = EVENT_TYPES.filter((t) => !overviewPartsFor(t).length);
  expect(silent).toContain('seat.status');
  expect(silent).toContain('message.question');
  expect(silent).not.toContain('gate.decided');
});

function setup() {
  const { api } = createFakeServer();
  const store = createWebStore();
  const onError = vi.fn();
  const overview = createOverviewRefresher({ api, store, onError });
  return { api, store, onError, overview };
}

test('refreshAll fetches every part with the inbox filters', async () => {
  const { api, store, overview } = setup();
  await overview.refreshAll();
  expect(api.listGates).toHaveBeenCalledWith({ status: 'open' });
  expect(api.listQuestions).toHaveBeenCalledWith({ status: 'escalated' });
  expect(api.listWorkflows).toHaveBeenCalledTimes(1);
  expect(api.listRepos).toHaveBeenCalledTimes(1);
  expect(store.getState().overview.health).toBe(health);
  expect(store.getState().auth).toBe('ok');
});

test('signals coalesce into one refetch per part 250 ms after the first', async () => {
  const { api, overview } = setup();
  overview.signal('gate.opened');
  await vi.advanceTimersByTimeAsync(200);
  overview.signal('gate.decided');
  overview.signal('usage.tokens');
  overview.signal('seat.status');
  await vi.advanceTimersByTimeAsync(OVERVIEW_DEBOUNCE_MS - 200 - 1);
  expect(api.listGates).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(api.listGates).toHaveBeenCalledTimes(1);
  expect(api.listWorkflows).toHaveBeenCalledTimes(1);
  expect(api.getHealth).not.toHaveBeenCalled();
  overview.signal('health.changed');
  await vi.advanceTimersByTimeAsync(OVERVIEW_DEBOUNCE_MS);
  expect(api.getHealth).toHaveBeenCalledTimes(1);
});

test('an older response never overwrites a newer one', async () => {
  const { api, store, overview } = setup();
  const resolvers: ((value: { workflows: WorkflowSummary[] }) => void)[] = [];
  api.listWorkflows.mockImplementation(
    () => new Promise((resolve) => resolvers.push(resolve)),
  );
  overview.signal('workflow.paused');
  await vi.advanceTimersByTimeAsync(OVERVIEW_DEBOUNCE_MS);
  overview.signal('workflow.resumed');
  await vi.advanceTimersByTimeAsync(OVERVIEW_DEBOUNCE_MS);
  const newer = [{ workflowId: 'new' } as WorkflowSummary];
  resolvers[1]!({ workflows: newer });
  await vi.advanceTimersByTimeAsync(0);
  resolvers[0]!({ workflows: [{ workflowId: 'old' } as WorkflowSummary] });
  await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().overview.workflows).toBe(newer);
});

test('errors are reported; dispose cancels pending refetches', async () => {
  const { api, onError, overview } = setup();
  api.listRepos.mockRejectedValueOnce(apiError(401));
  await overview.refreshAll();
  expect(onError).toHaveBeenCalledWith(apiError(401));
  overview.signal('repo.updated');
  overview.dispose();
  overview.signal('repo.updated');
  await vi.advanceTimersByTimeAsync(OVERVIEW_DEBOUNCE_MS * 2);
  expect(api.listRepos).toHaveBeenCalledTimes(1);
  // A response or failure that lands after dispose is dropped.
  api.listRepos.mockRejectedValueOnce(new Error('late'));
  await overview.refreshAll();
  expect(onError).toHaveBeenCalledTimes(1);
});
