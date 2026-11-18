import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
import { memo, Profiler, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  createAppliedBus,
  createWebStore,
  createTicker,
  RealtimeProvider,
  type Realtime,
} from '../../../realtime/index.js';
import { NavigationContext } from '../../../shared/ui/index.js';
import { createLog } from '../../../test-support/office/log.js';
import { mainline } from '../../../test-support/office/mainline.js';
import { OfficePage, OfficeBoardPage } from './OfficePage.js';
import { OfficeRightColumn } from './OfficeRightColumn.js';
import { useOfficeEffects } from './useOfficeEffects.js';
import { OfficeUsage } from '../ui/Usage.js';
import { OfficeLegend } from '../ui/Legend.js';
import { officeViewModel } from '../model/index.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { OfficeScene } from '../scene/OfficeScene.js';

const measurements = vi.hoisted(() => new Map<string, number[]>());
vi.mock('../scene/Seats.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../scene/Seats.js')>();
  return {
    ...original,
    SeatButton: memo(function MeasuredSeat(
      props: Parameters<typeof original.SeatButton>[0],
    ) {
      return (
        <Profiler
          id={props.seat.seatId}
          onRender={(id, _phase, duration) => {
            const samples = measurements.get(id) ?? [];
            samples.push(duration);
            measurements.set(id, samples);
          }}
        >
          <original.SeatButton {...props} />
        </Profiler>
      );
    }),
  };
});

let resize: (() => void) | undefined;
beforeEach(() => {
  history.replaceState(null, '', '/workflows/wf1');
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(fn: () => void) {
        resize = fn;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  measurements.clear();
});
function setup(model = mainline().at('meeting')) {
  const store = createWebStore();
  store.setState({
    active: { workflowId: model.workflowId, live: model, status: 'ready' },
  });
  const realtime = {
    store,
    bus: createAppliedBus(),
    ticker: createTicker({ clock: () => Date.parse(model.startedAt) }),
  } as Realtime;
  const navigate = vi.fn((href: string) => {
    history.replaceState(null, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RealtimeProvider realtime={realtime}>
      <NavigationContext value={{ navigate }}>{children}</NavigationContext>
    </RealtimeProvider>
  );
  return { realtime, wrapper, navigate };
}

test('scene selection fills inspector; whiteboard opens board; integer resize; desk focuses inbox', () => {
  const { wrapper, navigate } = setup();
  render(
    <>
      <div id="needs-you" tabIndex={-1} />
      <OfficePage />
      <OfficeRightColumn />
      <OfficeLegend />
    </>,
    { wrapper },
  );
  fireEvent.click(screen.getByTestId('seat-wf1:architect'));
  expect(location.search).toBe('?seat=wf1%3Aarchitect');
  expect(screen.getByTestId('office-seat-summary').textContent).toContain(
    'architect',
  );
  const host = screen.getByTestId('office-page');
  Object.defineProperty(host, 'clientWidth', {
    configurable: true,
    value: 1060,
  });
  act(() => resize?.());
  expect(screen.getByTestId('office-scene').getAttribute('data-scale')).toBe(
    '3',
  );
  fireEvent.click(screen.getByTestId('office-your-desk'));
  expect(document.activeElement?.id).toBe('needs-you');
  fireEvent.click(screen.getByTestId('office-whiteboard'));
  expect(navigate).toHaveBeenLastCalledWith(
    '/workflows/wf1/board?seat=wf1%3Aarchitect',
  );
  expect(screen.getByTestId('office-timeline-slot')).toBeTruthy();
});
test('inspector slot receives the URL selection, including none', () => {
  const { wrapper } = setup();
  const inspector = vi.fn((seatId: string | null) => (
    <p data-testid="slot">{seatId ?? 'none'}</p>
  ));
  render(
    <>
      <OfficePage />
      <OfficeRightColumn inspector={inspector} />
    </>,
    { wrapper },
  );
  expect(screen.getByTestId('slot').textContent).toBe('none');
  fireEvent.click(screen.getByTestId('seat-wf1:architect'));
  expect(screen.getByTestId('slot').textContent).toBe('wf1:architect');
  expect(screen.queryByTestId('office-seat-summary')).toBeNull();
});
test('board tolerates a queued item without PR, retains needs and selectable attempt lanes', () => {
  const log = createLog();
  log.stage('implement', 'implement');
  log.items('workitem.approved', [{ key: 'task' }]);
  log.dispatch('task', 'a');
  const model = structuredClone(log.model);
  model.workItems[0]!.status = 'merge_queued';
  delete model.workItems[0]!.pr;
  const { wrapper } = setup(model);
  render(<OfficeBoardPage />, { wrapper });
  expect(screen.getByTestId('board-column-queued').textContent).toContain(
    'task',
  );
  fireEvent.click(screen.getByTestId('board-lane-wf1:engineer:task-select'));
  expect(location.search).toContain('seat=');
  expect(
    screen.getByTestId('board-segment-a').getAttribute('aria-label'),
  ).toBeTruthy();
});
test('usage is paper and numbers without a limit, inspector never mounts on mobile', () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const { wrapper } = setup();
  render(
    <>
      <OfficeUsage totalTokens={150001} budgetDisabled />
      <OfficeRightColumn />
    </>,
    { wrapper },
  );
  expect(screen.getByTestId('usage-paper-stack').children).toHaveLength(4);
  expect(screen.getByTestId('token-usage').textContent).toContain('150,001');
  expect(screen.queryByTestId('office-inspector-slot')).toBeNull();
  expect(screen.queryByRole('progressbar')).toBeNull();
});
test('meeting bubbles are DOM text; gate scene removes departed meeting hit targets and plates', () => {
  const log = mainline();
  const { rerender } = render(
    <OfficeScene
      vm={officeViewModel(log.at('meeting'), { now: log.now, t })}
      t={t}
      scale={2}
      reducedMotion
    />,
  );
  expect(screen.getByTestId('seat-wf1:pm-bubble').textContent).toBeTruthy();
  rerender(
    <OfficeScene
      vm={officeViewModel(log.at('gate:conclusion'), { now: log.now, t })}
      t={t}
      scale={2}
      reducedMotion
    />,
  );
  expect(screen.queryByTestId('seat-wf1:pm')).toBeNull();
  expect(screen.queryByTestId('seat-wf1:pm-bubble')).toBeNull();
});
test('effects reject background and stale replay events, clear on seek, accept steps and acknowledge completion', () => {
  const log = createLog();
  log.stage('implement', 'implement');
  log.items('workitem.approved', [{ key: 'task' }]);
  const prev = log.model;
  log.dispatch('task', 'a');
  const next = log.model;
  const event = log.events.at(-1)!;
  const { realtime, wrapper } = setup(next);
  const { result } = renderHook(() => useOfficeEffects('wf1'), { wrapper });
  const applied = { event, prev, next, background: false };
  act(() => realtime.bus.emit({ ...applied, background: true }));
  expect(result.current.queue).toHaveLength(0);
  act(() => realtime.bus.emit(applied));
  expect(result.current.queue.length).toBeGreaterThan(0);
  const id = result.current.queue[0]!.id;
  act(() => result.current.onEffectDone(id));
  expect(result.current.queue.some((q) => q.id === id)).toBe(false);
  act(() =>
    realtime.store.setState({
      replay: {
        workflowId: 'wf1',
        eventCount: 10,
        seq: 1,
        model: prev,
        loading: false,
        progress: 1,
      },
    }),
  );
  expect(result.current.queue).toHaveLength(0);
  act(() => realtime.bus.emit(applied));
  expect(result.current.queue).toHaveLength(0);
  act(() => {
    realtime.store.setState((s) => ({
      replay: { ...s.replay!, seq: 2, model: next },
    }));
    realtime.bus.emit(applied);
  });
  expect(result.current.queue.length).toBeGreaterThan(0);
  act(() =>
    realtime.store.setState((s) => ({
      replay: { ...s.replay!, seq: 1, model: prev },
    })),
  );
  expect(result.current.queue).toHaveLength(0);
});
test('live events of one batch all animate, not only the last (final merge + completion)', () => {
  const log = createLog();
  log.stage('implement', 'implement');
  log.items('workitem.approved', [{ key: 'task' }]);
  const prev = log.model;
  log.dispatch('task', 'a');
  const middle = log.model;
  const event = log.events.at(-1)!;
  log.dispatch('task', 'b');
  // The store already holds the batch's final model when the bus emits.
  const { realtime, wrapper } = setup(log.model);
  const { result } = renderHook(() => useOfficeEffects('wf1'), { wrapper });
  act(() =>
    realtime.bus.emit({ event, prev, next: middle, background: false }),
  );
  expect(result.current.queue.length).toBeGreaterThan(0);
});
test('one activity event commits only the affected seat (React Profiler)', () => {
  const log = createLog();
  log.stage('implement', 'implement');
  log.items('workitem.approved', [{ key: 'one' }, { key: 'two' }]);
  log.dispatch('one', 'a').status('a', 'working');
  log.dispatch('two', 'b').status('b', 'working');
  const { realtime, wrapper } = setup(log.model);
  render(<OfficePage />, { wrapper });
  measurements.clear();
  log.activity('a', 'edit');
  act(() =>
    realtime.store.setState({
      active: { workflowId: 'wf1', live: log.model, status: 'ready' },
    }),
  );
  expect([...measurements.keys()]).toEqual(['wf1:engineer:one']);
  expect(measurements.get('wf1:engineer:one')).toHaveLength(1);
});

test('cancelling effects on catch-up preserves the user-selected room zoom', () => {
  const log = mainline();
  const vm = officeViewModel(log.at('meeting'), { now: log.now, t });
  const { rerender } = render(
    <OfficeScene vm={vm} t={t} scale={2} effectEpoch={0} reducedMotion />,
  );
  fireEvent.click(screen.getByTestId('room-meeting'));
  rerender(
    <OfficeScene vm={vm} t={t} scale={2} effectEpoch={1} reducedMotion />,
  );
  expect(screen.getByTestId('office-scene').getAttribute('data-zoom')).toBe(
    'meeting',
  );
});
