import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import {
  createAppliedBus,
  createTicker,
  createWebStore,
  RealtimeProvider,
  type Realtime,
} from '../../../realtime/index.js';
import { mainline } from '../../../test-support/office/mainline.js';
import { seatId } from '../../../test-support/office/log.js';
import { seatsT as t } from '../../../shared/lib/i18n/seats.js';
import { ApiError } from '../../../api/index.js';
import { SeatInspector, messageError } from './SeatInspector.js';
const log = mainline();
const id = seatId('engineer', 'feature');
function setup(mark = 'implement') {
  const model = structuredClone(log.at(mark));
  const store = createWebStore();
  store.setState({
    active: { workflowId: model.workflowId, live: model, status: 'ready' },
    auth: 'ok',
  });
  const realtime = {
    store,
    bus: createAppliedBus(),
    ticker: createTicker(),
    stop: vi.fn(),
  } as unknown as Realtime;
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ events: log.events }),
  );
  vi.stubGlobal('fetch', fetcher);
  const view = render(
    <RealtimeProvider realtime={realtime}>
      <SeatInspector seatId={id} />
    </RealtimeProvider>,
  );
  return {
    ...view,
    model,
    realtime,
    fetcher,
    select: (seatId: string | null) =>
      view.rerender(
        <RealtimeProvider realtime={realtime}>
          <SeatInspector seatId={seatId} />
        </RealtimeProvider>,
      ),
  };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('renders all worker blocks and sends once using the API-generated subject', async () => {
  const h = setup('rework');
  h.select(seatId('integrator'));
  await waitFor(() =>
    expect(screen.getByTestId('seat-reviews').textContent).toContain(
      'missing tests',
    ),
  );
  expect(screen.getByTestId('seat-avatar')).toBeTruthy();
  expect(screen.getByTestId('seat-ondemand').textContent).toBe(
    t('seats.merge'),
  );
  h.select(id);
  expect(screen.getByTestId('seat-message-body').hasAttribute('disabled')).toBe(
    true,
  );
  h.select(seatId('integrator'));
  h.fetcher.mockResolvedValueOnce(Response.json({ accepted: true }));
  const user = userEvent.setup();
  await user.type(
    screen.getByTestId('seat-message-body'),
    'Check contrast\nPlease verify keyboard access.',
  );
  await user.click(screen.getByTestId('seat-message-send'));
  await waitFor(() =>
    expect(screen.getByTestId('seat-message-result').textContent).toBe(
      t('seats.sent'),
    ),
  );
  const sent = h.fetcher.mock.calls.find(
    ([, init]) => init?.method === 'POST',
  )!;
  expect(sent[0]).toBe(
    `/api/v1/seats/${encodeURIComponent(seatId('integrator'))}/message`,
  );
  expect(JSON.parse(sent[1]!.body as string)).toEqual({
    subject: 'Check contrast',
    body: 'Check contrast\nPlease verify keyboard access.',
  });
  expect(
    (screen.getByTestId('seat-message-body') as HTMLTextAreaElement).value,
  ).toBe('');
});

test('replay with null model, released seats, meetings, and absent selection disable messaging', async () => {
  const h = setup();
  await screen.findByTestId('seat-message-body');
  act(() =>
    h.realtime.store.setState({
      replay: {
        workflowId: 'wf1',
        eventCount: 0,
        seq: 0,
        model: null,
        loading: true,
        progress: 0,
      },
    }),
  );
  expect(screen.getByTestId('seat-message-body').hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByTestId('seat-message-disabled').textContent).toBe(
    t('seats.disabled.replay'),
  );
  act(() =>
    h.realtime.store.setState({
      replay: null,
      active: { workflowId: 'wf1', live: log.at('meeting'), status: 'ready' },
    }),
  );
  h.select(seatId('pm'));
  expect(screen.getByTestId('seat-meeting')).toBeTruthy();
  expect(screen.getByTestId('seat-message-disabled').textContent).toBe(
    t('seats.disabled.meeting'),
  );
  h.select(null);
  expect(screen.getByTestId('seat-inspector-empty').textContent).toBe(
    t('seats.select'),
  );
  h.select('missing');
  expect(screen.getByTestId('seat-inspector-empty').textContent).toBe(
    t('seats.missing'),
  );
});

test('retains failed draft, does not automatically retry, and invalidates auth on 401', async () => {
  const h = setup();
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(1));
  h.fetcher.mockResolvedValueOnce(
    Response.json(
      {
        error: {
          code: 'no_live_attempt',
          category: 'conflict',
          retryable: false,
          message: 'diagnostic',
        },
      },
      { status: 409 },
    ),
  );
  fireEvent.change(screen.getByTestId('seat-message-body'), {
    target: { value: 'Please check' },
  });
  fireEvent.click(screen.getByTestId('seat-message-send'));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe(
      t('seats.error.conflict'),
    ),
  );
  expect(
    (screen.getByTestId('seat-message-body') as HTMLTextAreaElement).value,
  ).toBe('Please check');
  expect(h.fetcher).toHaveBeenCalledTimes(2);
  h.fetcher.mockResolvedValueOnce(Response.json({}, { status: 401 }));
  fireEvent.click(screen.getByTestId('seat-message-send'));
  await waitFor(() => expect(h.realtime.store.getState().auth).toBe('missing'));
  expect(h.realtime.stop).toHaveBeenCalledOnce();
});

test('pending duplicate submits and seat switching cannot reuse a draft or success', async () => {
  const h = setup();
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(1));
  let finish!: (response: Response) => void;
  h.fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.change(screen.getByTestId('seat-message-body'), {
    target: { value: 'One instruction' },
  });
  fireEvent.submit(screen.getByRole('form'));
  fireEvent.submit(screen.getByRole('form'));
  expect(h.fetcher).toHaveBeenCalledTimes(2);
  h.select(seatId('engineer', 'persist'));
  await act(async () => finish(Response.json({ accepted: true })));
  expect(screen.queryByTestId('seat-message-result')).toBeNull();
  expect(
    (screen.getByTestId('seat-message-body') as HTMLTextAreaElement).value,
  ).toBe('');
});

test('history paging and SSE dedupe remain bounded by replay seq', async () => {
  const h = setup('review');
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(1));
  const event = log.events.find((e) => e.type === 'workitem.rework_requested')!;
  act(() =>
    h.realtime.bus.emit({
      event,
      prev: h.model,
      next: log.at('rework'),
      background: true,
    }),
  );
  expect(screen.getByTestId('seat-reviews').textContent).not.toContain(
    'missing tests',
  );
  act(() =>
    h.realtime.store.setState({
      active: { workflowId: 'wf1', live: log.at('rework'), status: 'ready' },
    }),
  );
  expect(screen.getAllByText('missing tests')).toHaveLength(1);
});

test('blank first line is not submitted and history load failures can be retried', async () => {
  const h = setup();
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByTestId('seat-message-body'), {
    target: { value: '\nText' },
  });
  fireEvent.submit(screen.getByRole('form'));
  expect(h.fetcher).toHaveBeenCalledTimes(1);
});

test.each([
  [401, 'auth', false, 'seats.error.auth'],
  [409, 'conflict', false, 'seats.error.conflict'],
  [404, 'permanent', false, 'seats.error.conflict'],
  [422, 'validation', false, 'seats.error.validation'],
  [429, 'rate_limited', false, 'seats.error.rateLimited'],
  [0, 'transient', true, 'seats.error.unknown'],
  [503, 'transient', true, 'seats.error.unknown'],
  [403, 'guard', false, 'seats.error.failed'],
] as const)(
  'localizes HTTP %s without rendering diagnostics',
  (status, category, retryable, key) => {
    expect(
      messageError(
        new ApiError(status, {
          code: 'test',
          message: 'private diagnostic',
          category,
          retryable,
        }),
      ),
    ).toBe(t(key));
    expect(messageError(new Error())).toBe(t('seats.error.unknown'));
  },
);

test('errors, optional rate limit and attempt history are accessible without transcript content', async () => {
  const h = setup();
  const seat = h.model.seats.find((s) => s.seatId === id)!;
  const a = seat.attempts.at(-1)!;
  Object.assign(a, { rateLimited: { since: a.startedAt } });
  seat.errors = [
    {
      seq: 1,
      at: a.startedAt,
      category: 'permanent',
      code: 'runtime_unavailable',
      message: 'Runtime unavailable',
    },
  ];
  act(() =>
    h.realtime.store.setState({
      active: {
        workflowId: 'wf1',
        live: structuredClone(h.model),
        status: 'ready',
      },
    }),
  );
  expect(screen.getByTestId('seat-state').textContent).toBe(
    t('seats.rateLimited'),
  );
  expect(screen.getByTestId('seat-errors').textContent).toContain(
    'runtime_unavailable',
  );
  await userEvent.setup().click(screen.getByTestId('seat-attempt-toggle'));
  expect(screen.getByTestId('seat-attempt-history').hasAttribute('open')).toBe(
    true,
  );
  expect(screen.getByTestId('seat-attempt-history').textContent).toContain(
    '220,000',
  );
});
