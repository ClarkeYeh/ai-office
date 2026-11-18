import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { ApiClient } from '../../../api/index.js';
import {
  createAppliedBus,
  RealtimeProvider,
  type Realtime,
} from '../../../realtime/index.js';
import { mainline } from '../../../test-support/office/mainline.js';
import { useReviewHistory } from './history.js';
const log = mainline();
const event = log.events.find((e) => e.type === 'workitem.rework_requested')!;
afterEach(cleanup);
function setup(
  api: Pick<ApiClient, 'listEvents'>,
  workflowId: string | null = 'wf1',
) {
  const realtime = { bus: createAppliedBus() } as Realtime;
  const view = renderHook(({ id }) => useReviewHistory(id, api), {
    initialProps: { id: workflowId },
    wrapper: ({ children }: { children: ReactNode }) => (
      <RealtimeProvider realtime={realtime}>{children}</RealtimeProvider>
    ),
  });
  return { ...view, realtime };
}

test('paginates, subscribes before fetch, and dedupes overlapping live events', async () => {
  let resolve!: (page: Awaited<ReturnType<ApiClient['listEvents']>>) => void;
  const listEvents = vi
    .fn<ApiClient['listEvents']>()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce({ events: [event] });
  const h = setup({ listEvents });
  act(() =>
    h.realtime.bus.emit({
      event,
      prev: null,
      next: log.model,
      background: false,
    }),
  );
  await act(async () => resolve({ events: [event], nextAfterSeq: event.seq }));
  await waitFor(() => expect(h.result.current.state).toBe('ready'));
  expect(h.result.current.events).toEqual([event]);
  expect(listEvents.mock.calls[1]?.[1]?.afterSeq).toBe(event.seq);
});

test('reports failure and retries; switching workflows discards old responses', async () => {
  const listEvents = vi
    .fn<ApiClient['listEvents']>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ events: [event] });
  const h = setup({ listEvents });
  await waitFor(() => expect(h.result.current.state).toBe('error'));
  act(() => h.result.current.retry());
  await waitFor(() => expect(h.result.current.state).toBe('ready'));
  expect(h.result.current.events).toEqual([event]);
  let finish!: (page: Awaited<ReturnType<ApiClient['listEvents']>>) => void;
  listEvents.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  h.rerender({ id: 'old' });
  const signal = listEvents.mock.calls.at(-1)![2]!.signal!;
  h.rerender({ id: null });
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ events: [event] }));
  expect(h.result.current.events).toEqual([]);
});

test('rejects non-advancing pagination instead of looping', async () => {
  const h = setup({
    listEvents: vi
      .fn<ApiClient['listEvents']>()
      .mockResolvedValue({ events: [], nextAfterSeq: 0 }),
  });
  await waitFor(() => expect(h.result.current.state).toBe('error'));
});
