import type { DomainEvent } from '@ai-office/contracts/events';

export const BUFFER_CAPACITY = 2_000;

interface Ring {
  items: DomainEvent[];
  head: number;
  size: number;
  /** Seq of the newest evicted event; history at or below it is gone. */
  evictedThrough: number;
}

/**
 * The most recent events of every workflow seen on the global stream, so switching the
 * active workflow can replay `seq > snapshot` without refetching (M4_PLAN §3.4).
 */
export interface EventBuffers {
  push(event: DomainEvent): void;
  /** Buffered events of `workflowId` with `seq > afterSeq`, in seq order. */
  after(workflowId: string, afterSeq: number): DomainEvent[];
  /** The buffer holds every event of `workflowId` with seq greater than this. */
  completeAfter(workflowId: string): number;
  /** Events at or below `seq` were never received (new stream lower bound). */
  raiseFloor(seq: number): void;
}

export function createEventBuffers(
  capacity = BUFFER_CAPACITY,
  floor = 0,
): EventBuffers {
  const rings = new Map<string, Ring>();
  return {
    push(event) {
      if (!event.workflowId) return;
      let ring = rings.get(event.workflowId);
      if (!ring) {
        ring = { items: [], head: 0, size: 0, evictedThrough: 0 };
        rings.set(event.workflowId, ring);
      }
      if (ring.size < capacity) {
        ring.items.push(event);
        ring.size++;
        return;
      }
      ring.evictedThrough = ring.items[ring.head]!.seq;
      ring.items[ring.head] = event;
      ring.head = (ring.head + 1) % capacity;
    },
    after(workflowId, afterSeq) {
      const ring = rings.get(workflowId);
      if (!ring) return [];
      const result: DomainEvent[] = [];
      for (let i = 0; i < ring.size; i++) {
        const event = ring.items[(ring.head + i) % capacity]!;
        if (event.seq > afterSeq) result.push(event);
      }
      return result;
    },
    completeAfter(workflowId) {
      return Math.max(floor, rings.get(workflowId)?.evictedThrough ?? 0);
    },
    raiseFloor(seq) {
      floor = Math.max(floor, seq);
    },
  };
}
