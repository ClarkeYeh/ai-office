import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { PauseReasonSchema } from '@ai-office/contracts/events';
import type { HealthView } from '@ai-office/contracts/api';
import { t, hasMessage } from '../shared/lib/i18n/index.js';
import { Banners } from './Banners.js';
afterEach(cleanup);
test.each(PauseReasonSchema.options)(
  'renders the %s pause reason',
  (reason) => {
    render(<Banners pausedReasons={[reason]} />);
    const key = `pause.${reason}`;
    expect(hasMessage(key)).toBe(true);
    if (hasMessage(key))
      expect(screen.getByTestId(`pause-${reason}`).textContent).toContain(
        t(key),
      );
  },
);
test('future pause reasons have a safe translated fallback', () => {
  render(<Banners pausedReasons={['future', 'toString']} />);
  expect(screen.getByTestId('pause-future').textContent).toContain(
    t('banner.unknownPause'),
  );
  expect(screen.getByTestId('pause-toString').textContent).toContain(
    t('banner.unknownPause'),
  );
});
test('shows health, hijack, unverified, fake, degraded, replay and synchronization overlays', () => {
  const health: HealthView = {
    status: 'unhealthy',
    runtime: {
      status: 'unhealthy',
      mode: 'fake',
      verified: false,
      runOwned: false,
    },
    scm: { status: 'unhealthy' },
    store: { status: 'unhealthy' },
    usage: { status: 'unhealthy', sources: [] },
    adapters: [],
  };
  render(
    <Banners
      health={health}
      degraded
      replaying
      syncing
      connection="reconnecting"
    />,
  );
  for (const id of [
    'health-runtime',
    'health-scm',
    'health-store',
    'health-usage',
    'banner-hijacked',
    'banner-unverified',
    'banner-fake',
    'banner-degraded',
    'banner-replay',
    'banner-syncing',
    'banner-connection',
  ])
    expect(screen.getByTestId(id)).toBeTruthy();
});
test('healthy production has no banners', () => {
  const health: HealthView = {
    status: 'healthy',
    runtime: {
      status: 'healthy',
      mode: 'orca',
      verified: true,
      runOwned: true,
    },
    scm: { status: 'healthy' },
    store: { status: 'healthy' },
    usage: { status: 'healthy', sources: [] },
    adapters: [],
  };
  render(<Banners health={health} connection="live" />);
  expect(screen.getByTestId('banners').textContent).toBe('');
});
