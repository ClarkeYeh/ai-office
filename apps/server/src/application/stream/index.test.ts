import { describe, expect, it, vi } from 'vitest';
import { InMemoryEventStore } from '../../test-support/stores.js';
import { eventDraft } from '../../test-support/contracts.js';
import { StreamService } from './index.js';

describe('StreamService', () => {
  it('subscribes before history and merges racing commits once in seq order', async () => {
    const events = new InMemoryEventStore();
    events.append([eventDraft()]);
    const read = events.read.bind(events);
    vi.spyOn(events, 'read').mockImplementationOnce((q) => {
      const history = read(q);
      events.append([eventDraft(), eventDraft()]);
      // Simulate one event present both in history and the subscriber buffer.
      return [...history, ...read({ afterSeq: 1, limit: 1 })];
    });
    const stream = new StreamService(events).open();
    const frames = await Promise.all([
      stream.next(),
      stream.next(),
      stream.next(),
    ]);
    expect(frames.map((r) => r.value.id)).toEqual(['1', '2', '3']);
    const pending = stream.next();
    events.append([eventDraft()]);
    expect((await pending).value.id).toBe('4');
    await stream.return();
  });

  it('filters workflow streams and includes system and other workflow events globally', async () => {
    const events = new InMemoryEventStore();
    events.append([
      eventDraft(undefined, 'a'),
      eventDraft(undefined, null),
      eventDraft(undefined, 'b'),
    ]);
    const service = new StreamService(events);
    const global = service.open({ afterSeq: 1 });
    expect((await global.next()).value.id).toBe('2');
    expect((await global.next()).value.id).toBe('3');
    const a = service.open({ workflowId: 'a' });
    expect((await a.next()).value.id).toBe('1');
    const pending = a.next();
    events.append([eventDraft(undefined, 'b'), eventDraft(undefined, 'a')]);
    expect((await pending).value.id).toBe('5');
    await a.return();
    await global.return();
  });

  it('resyncs only above 1000 queued live events and then ends', async () => {
    const events = new InMemoryEventStore();
    const stream = new StreamService(events).open();
    events.append(Array.from({ length: 1000 }, () => eventDraft()));
    expect((await stream.next()).value.id).toBe('1');
    events.append([eventDraft(), eventDraft()]);
    expect((await stream.next()).value.event).toBe('resync_required');
    expect((await stream.next()).done).toBe(true);
    events.append([eventDraft()]);
    expect((await stream.next()).done).toBe(true);
  });

  it('bounds historical and subscription-race backlogs', async () => {
    for (const racing of [false, true]) {
      const events = new InMemoryEventStore();
      const batch = Array.from({ length: 1001 }, () => eventDraft());
      if (racing) {
        vi.spyOn(events, 'read').mockImplementationOnce(() => {
          events.append(batch);
          return [];
        });
      } else events.append(batch);
      const stream = new StreamService(events).open();
      expect((await stream.next()).value.event).toBe('resync_required');
      expect((await stream.next()).done).toBe(true);
    }
  });

  it('cleans up subscriptions on disconnect and history failure', async () => {
    const events = new InMemoryEventStore();
    const subscribe = events.subscribe.bind(events);
    const detached = vi.fn();
    vi.spyOn(events, 'subscribe').mockImplementation((listener) => {
      const unsubscribe = subscribe(listener);
      return () => {
        unsubscribe();
        detached();
      };
    });
    const stream = new StreamService(events).open();
    const pending = stream.next();
    await expect(stream.next()).rejects.toThrow('pending');
    await stream.return();
    expect((await pending).done).toBe(true);
    expect(detached).toHaveBeenCalledTimes(1);
    vi.spyOn(events, 'read').mockImplementationOnce(() => {
      throw new Error('read failed');
    });
    expect(() => new StreamService(events).open()).toThrow('read failed');
    expect(detached).toHaveBeenCalledTimes(2);
    expect(() => new StreamService(events).open({ afterSeq: -1 })).toThrow(
      RangeError,
    );
  });
});
