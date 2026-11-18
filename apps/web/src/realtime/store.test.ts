import { expect, test } from 'vitest';
import { replay } from '@ai-office/projection';
import {
  createWebStore,
  initialWebState,
  selectDisplayedModel,
} from './store.js';
import { workflowEvents } from './test-support/events.js';

test('displayed model is the replay model when present, else live', () => {
  const store = createWebStore();
  expect(store.getState()).toEqual(initialWebState());
  expect(selectDisplayedModel(store.getState())).toBeNull();
  const live = replay(workflowEvents(3))!;
  const past = replay(workflowEvents(2))!;
  store.setState({ active: { workflowId: 'wf1', live, status: 'ready' } });
  expect(selectDisplayedModel(store.getState())).toBe(live);
  const replaying = {
    workflowId: 'wf1',
    eventCount: 3,
    seq: 2,
    model: null,
    loading: true,
    progress: 0.5,
  };
  store.setState({ replay: replaying });
  // A loading replay keeps showing live instead of an empty office.
  expect(selectDisplayedModel(store.getState())).toBe(live);
  store.setState({ replay: { ...replaying, model: past } });
  expect(selectDisplayedModel(store.getState())).toBe(past);
});
