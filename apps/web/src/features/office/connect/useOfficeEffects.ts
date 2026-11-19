import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useAppliedEvents,
  useRealtime,
  selectDisplayedModel,
} from '../../../realtime/index.js';
import { effects } from '../model/index.js';
import { MAX_PLAYING, MAX_WAITING, type QueuedEffect } from '../scene/index.js';

/** The bus emits replay steps, but never seeks. Clear existing animations on a
 * seek, background catch-up, workflow switch or departure from this page. */
export function useOfficeEffects(workflowId: string | undefined) {
  const realtime = useRealtime();
  const [queue, setQueue] = useState<QueuedEffect[]>([]);
  const [generation, setGeneration] = useState(0);
  const nextId = useRef(0);
  const displayed = useRef(selectDisplayedModel(realtime.store.getState()));
  const clear = useCallback(() => {
    setQueue([]);
    setGeneration((n) => n + 1);
  }, []);
  useEffect(() => {
    clear();
    return realtime.store.subscribe((state, prev) => {
      const next = selectDisplayedModel(state);
      if (
        state.replay !== prev.replay &&
        ((state.replay === null) !== (prev.replay === null) ||
          state.replay?.seq !== prev.replay?.seq ||
          next !== displayed.current)
      )
        clear();
      displayed.current = next;
    });
  }, [realtime, workflowId, clear]);
  useAppliedEvents((applied) => {
    const state = realtime.store.getState();
    if (applied.event.workflowId !== workflowId) return;
    if (applied.background) {
      clear();
      return;
    }
    // Reject stale/live-model events while replay displays a different snapshot.
    // Live events of one frame batch carry intermediate models, so only replay compares.
    if (state.replay !== null && applied.next !== selectDisplayedModel(state))
      return;
    const fresh = effects(applied.event, applied.prev, applied.next).map(
      (effect) => ({ id: nextId.current++, effect }),
    );
    if (fresh.length)
      setQueue((q) => [...q, ...fresh].slice(-(MAX_PLAYING + MAX_WAITING)));
  });
  const onEffectDone = useCallback((id: number) => {
    setQueue((q) => q.filter((entry) => entry.id !== id));
  }, []);
  return { queue, generation, onEffectDone };
}
