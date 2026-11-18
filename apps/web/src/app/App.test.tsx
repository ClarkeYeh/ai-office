import { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { HealthView } from '@ai-office/contracts/api';
import { createApiClient } from '../api/index.js';
import { createRealtime } from '../realtime/index.js';
import { t } from '../shared/lib/i18n/index.js';
import { App } from './App.js';
import { createAppServices } from './providers.js';
import { ErrorBoundary } from './ErrorBoundary.js';
const health: HealthView = {
  status: 'healthy',
  runtime: { status: 'healthy', mode: 'fake', verified: true },
  scm: { status: 'healthy' },
  store: { status: 'healthy' },
  usage: { status: 'healthy', sources: [] },
  adapters: [],
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup() {
  globalThis.history.replaceState(null, '', '/');
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const api = {
    ...createApiClient(),
    getHealth: vi.fn().mockResolvedValue(health),
  };
  const realtime = createRealtime({
    api,
    openEventSource: () => {
      throw new Error('unexpected stream');
    },
    createWorker: () => {
      throw new Error('unexpected worker');
    },
  });
  vi.spyOn(realtime, 'start').mockResolvedValue(undefined);
  return { api, realtime };
}
test('valid session mounts routes and starts one realtime owner under StrictMode', async () => {
  const services = setup();
  const stop = vi.spyOn(services.realtime, 'stop');
  const { unmount } = render(
    <StrictMode>
      <App services={services} />
    </StrictMode>,
  );
  await waitFor(() => expect(screen.getByTestId('new-workflow')).toBeTruthy());
  expect(services.realtime.start).toHaveBeenCalledTimes(1);
  unmount();
  expect(stop).toHaveBeenCalled();
});
test('missing session and stream expiry show the same instruction and hide routes', async () => {
  const services = setup();
  render(<App services={services} />);
  await waitFor(() => expect(screen.getByTestId('new-workflow')).toBeTruthy());
  act(() => services.realtime.store.setState({ auth: 'missing' }));
  expect(screen.getByTestId('auth-required').textContent).toContain(
    t('auth.command'),
  );
  expect(screen.queryByTestId('new-workflow')).toBeNull();
});
test('REST 401 stops realtime and invalidates shared authentication state', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('{}', { status: 401 })),
  );
  const services = createAppServices();
  const stop = vi.spyOn(services.realtime, 'stop');
  await expect(services.api.listTemplates()).rejects.toMatchObject({
    status: 401,
  });
  expect(stop).toHaveBeenCalledOnce();
  expect(services.realtime.store.getState().auth).toBe('missing');
});
test('unavailable backend gives retry state rather than claiming missing authentication', async () => {
  const services = setup();
  services.api.getHealth.mockRejectedValue(new Error('offline'));
  render(<App services={services} />);
  await waitFor(() => expect(screen.getByTestId('auth-retry')).toBeTruthy());
  expect(screen.queryByTestId('auth-required')).toBeNull();
});
test('late health probes after unmount cannot restart the stream', async () => {
  const services = setup();
  let resolve!: (health: HealthView) => void;
  services.api.getHealth.mockReturnValue(
    new Promise<HealthView>((done) => {
      resolve = done;
    }),
  );
  const { unmount } = render(<App services={services} />);
  unmount();
  await act(async () => {
    resolve(health);
  });
  expect(services.realtime.start).not.toHaveBeenCalled();
});
test('error boundary shows localized recovery without exposing the exception', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  function Broken(): never {
    throw new Error('private diagnostic');
  }
  render(
    <ErrorBoundary>
      <Broken />
    </ErrorBoundary>,
  );
  expect(screen.getByRole('alert').textContent).toContain(t('app.error'));
  expect(screen.getByRole('alert').textContent).not.toContain(
    'private diagnostic',
  );
});
