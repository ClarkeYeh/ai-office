import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { evolve, type ReadModel } from '@ai-office/projection';
import { createRealtime, RealtimeProvider } from '../../../realtime/index.js';
import {
  createFakeServer,
  FakeWorker,
  resetFakes,
} from '../../../realtime/test-support/fakes.js';
import {
  workflowEvents,
  usageTokens,
} from '../../../realtime/test-support/events.js';
import { mainline } from '../../../test-support/office/mainline.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { TimelinePage } from './TimelinePage.js';

afterEach(() => {
  cleanup();
  resetFakes();
});
function setup(events = workflowEvents(8, 'wf1', 10, 10)) {
  const server = createFakeServer(events);
  const realtime = createRealtime({
    api: server.api,
    createWorker: () => new FakeWorker(),
    openEventSource: () => {
      throw new Error('not used');
    },
  });
  let live: ReadModel | null = null;
  for (const event of events) live = evolve(live, event);
  realtime.store.setState({
    active: { workflowId: 'wf1', live, status: 'ready' },
  });
  render(
    <RealtimeProvider realtime={realtime}>
      <TimelinePage route={{ params: { id: 'wf1' } }} />
    </RealtimeProvider>,
  );
  return { ...server, realtime };
}
async function open() {
  fireEvent.click(screen.getByTestId('timeline-open'));
  await waitFor(() =>
    expect(
      (screen.getByTestId('timeline-scrubber') as HTMLInputElement).disabled,
    ).toBe(false),
  );
}

test('keyboard seeks, stepping, markers and back-to-live use the shared replay controller', async () => {
  const { realtime } = setup();
  const applied: number[] = [];
  realtime.bus.subscribe((e) => applied.push(e.event.seq));
  await open();
  const slider = screen.getByTestId('timeline-scrubber');
  fireEvent.keyDown(slider, { key: 'Home' });
  await waitFor(() =>
    expect(realtime.store.getState().replay?.model?.lastSeq).toBe(10),
  );
  expect(applied).toEqual([]);
  fireEvent.keyDown(slider, { key: 'ArrowRight' });
  expect(realtime.store.getState().replay?.seq).toBe(20);
  expect(applied).toEqual([20]);
  fireEvent.keyDown(slider, { key: 'ArrowUp' });
  expect(applied).toEqual([20, 30]);
  fireEvent.keyDown(slider, { key: 'ArrowLeft' });
  await waitFor(() =>
    expect(realtime.store.getState().replay?.model?.lastSeq).toBe(20),
  );
  fireEvent.keyDown(slider, { key: 'ArrowDown' });
  await waitFor(() =>
    expect(realtime.store.getState().replay?.model?.lastSeq).toBe(10),
  );
  fireEvent.keyDown(slider, { key: 'End' });
  await waitFor(() =>
    expect(realtime.store.getState().replay?.model?.lastSeq).toBe(80),
  );
  expect(
    (screen.getByTestId('timeline-next') as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(slider, { target: { value: '3' } });
  await waitFor(() =>
    expect(realtime.store.getState().replay?.model?.lastSeq).toBe(40),
  );
  expect(applied).toEqual([20, 30]);
  expect(screen.getByTestId('timeline-readonly').textContent).toBe(
    t('timeline.readOnly'),
  );
  const live = evolve(
    realtime.store.getState().active.live,
    usageTokens(90, 'a1'),
  );
  act(() => {
    realtime.store.setState({
      active: { workflowId: 'wf1', live, status: 'ready' },
    });
    realtime.replay.onLive(usageTokens(90, 'a1'));
  });
  expect(realtime.store.getState().replay?.seq).toBe(40);
  fireEvent.click(screen.getByTestId('timeline-live'));
  expect(realtime.store.getState().replay).toBeNull();
  expect(realtime.store.getState().active.live).toBe(live);
  expect(screen.queryByTestId('timeline-readonly')).toBeNull();
});

test('golden: replay through the worker equals the live fold at every mainline event', async () => {
  const log = mainline();
  const { realtime } = setup(log.events);
  await open();
  for (let index = 0; index < log.events.length; index++) {
    fireEvent.change(screen.getByTestId('timeline-scrubber'), {
      target: { value: String(index) },
    });
    await waitFor(() =>
      expect(realtime.store.getState().replay?.model).toEqual(
        log.models[index],
      ),
    );
  }
  const marker = screen.getAllByTestId(/^timeline-marker-/)[0]!;
  fireEvent.click(marker);
  await waitFor(() =>
    expect(realtime.store.getState().replay?.model?.lastSeq).toBe(
      Number(marker.dataset.testid!.split('-').at(-1)),
    ),
  );
  fireEvent.click(screen.getByTestId('timeline-first'));
  await waitFor(() =>
    expect(realtime.store.getState().replay?.model?.lastSeq).toBe(1),
  );
  fireEvent.click(screen.getByTestId('timeline-next'));
  expect(realtime.store.getState().replay?.seq).toBe(2);
  fireEvent.click(screen.getByTestId('timeline-last'));
  await waitFor(() =>
    expect(realtime.store.getState().replay?.model).toEqual(log.model),
  );
  fireEvent.click(screen.getByTestId('timeline-previous'));
  await waitFor(() =>
    expect(realtime.store.getState().replay?.model).toEqual(log.models.at(-2)),
  );
}, 30_000);

test('failed load offers retry; loading can be cancelled without restoring replay later', async () => {
  const { api, realtime } = setup();
  api.listEvents.mockRejectedValueOnce(new Error('private error'));
  await act(async () => {
    fireEvent.click(screen.getByTestId('timeline-open'));
  });
  expect(screen.getByTestId('timeline-error').textContent).not.toContain(
    'private error',
  );
  fireEvent.click(screen.getByTestId('timeline-retry'));
  await waitFor(() =>
    expect(realtime.store.getState().replay?.model).not.toBeNull(),
  );
  fireEvent.click(screen.getByTestId('timeline-live'));
  let resolve!: (value: { events: never[] }) => void;
  api.listEvents.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  fireEvent.click(screen.getByTestId('timeline-open'));
  expect(
    (screen.getByTestId('timeline-scrubber') as HTMLInputElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByTestId('timeline-live'));
  await act(async () => {
    resolve({ events: [] });
  });
  expect(realtime.store.getState().replay).toBeNull();
});

test('empty history remains usable and disables navigation', async () => {
  setup([]);
  fireEvent.click(screen.getByTestId('timeline-open'));
  await waitFor(() =>
    expect(screen.getByText(t('timeline.empty'))).toBeTruthy(),
  );
  expect(
    (screen.getByTestId('timeline-next') as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByTestId('timeline-live'));
  expect(screen.getByTestId('timeline-open')).toBeTruthy();
});
