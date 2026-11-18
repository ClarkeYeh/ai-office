import { useEffect, useState } from 'react';
import type { InspectorEvent as DomainEvent } from '../model/seatInspector.js';
import type { ApiClient } from '../../../api/index.js';
import { useRealtime } from '../../../realtime/index.js';

const EMPTY: readonly DomainEvent[] = [];
/** Subscribe before paging, merge by seq, and retain only review metadata. */
export function useReviewHistory(
  workflowId: string | null,
  api: Pick<ApiClient, 'listEvents'>,
) {
  const { bus } = useRealtime();
  const [generation, retry] = useState(0);
  const [history, setHistory] = useState<{
    workflowId: string | null;
    events: readonly DomainEvent[];
    state: 'loading' | 'ready' | 'error';
  }>({ workflowId: null, events: EMPTY, state: 'loading' });
  useEffect(() => {
    if (!workflowId) return;
    const controller = new AbortController();
    const events = new Map<number, DomainEvent>();
    let state: 'loading' | 'ready' | 'error' = 'loading';
    const add = (event: DomainEvent) => {
      if (
        event.workflowId === workflowId &&
        (event.type === 'workitem.rework_requested' ||
          (event.type === 'workitem.status' &&
            event.payload.status === 'in_review'))
      )
        events.set(event.seq, event);
    };
    const publish = () => {
      if (!controller.signal.aborted)
        setHistory({
          workflowId,
          events: [...events.values()].sort((a, b) => a.seq - b.seq),
          state,
        });
    };
    const unsubscribe = bus.subscribe(({ event }) => {
      add(event);
      if (events.has(event.seq)) publish();
    });
    publish();
    void (async () => {
      try {
        let afterSeq = 0;
        for (;;) {
          const page = await api.listEvents(
            workflowId,
            { afterSeq, limit: 500 },
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          page.events.forEach(add);
          if (page.nextAfterSeq === undefined) break;
          if (page.nextAfterSeq <= afterSeq)
            throw new Error('non-advancing event page');
          afterSeq = page.nextAfterSeq;
        }
        state = 'ready';
      } catch {
        state = 'error';
      }
      publish();
    })();
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [api, bus, workflowId, generation]);
  return {
    events: history.workflowId === workflowId ? history.events : EMPTY,
    state:
      history.workflowId === workflowId ? history.state : ('loading' as const),
    retry: () => retry((n) => n + 1),
  };
}
