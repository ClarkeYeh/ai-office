import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ReadModel } from '@ai-office/projection';
import type { WebState } from './types.js';

export type WebStore = StoreApi<WebState>;

export const initialWebState = (): WebState => ({
  auth: 'unknown',
  connection: { status: 'connecting', cursor: 0, catchingUp: false },
  overview: {
    workflows: [],
    gates: [],
    questions: [],
    health: null,
    repos: [],
  },
  active: { workflowId: null, live: null, status: 'idle' },
  replay: null,
});

export function createWebStore(
  initial: WebState = initialWebState(),
): WebStore {
  return createStore<WebState>()(() => initial);
}

/** Replay is transparent to features: they always read this (stable reference). */
export const selectDisplayedModel = (state: WebState): ReadModel | null =>
  state.replay?.model ?? state.active.live;
