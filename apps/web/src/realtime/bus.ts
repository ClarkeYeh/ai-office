import type { AppliedEvent } from './types.js';

export type AppliedListener = (applied: AppliedEvent) => void;

export interface AppliedBus {
  subscribe(listener: AppliedListener): () => void;
  emit(applied: AppliedEvent): void;
}

export function createAppliedBus(): AppliedBus {
  const listeners = new Set<AppliedListener>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(applied) {
      // A throwing subscriber must not starve the others or the store update.
      for (const listener of [...listeners])
        try {
          listener(applied);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
    },
  };
}
