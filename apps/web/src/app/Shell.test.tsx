import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { t } from '../shared/lib/i18n/index.js';
import { Shell } from './Shell.js';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function viewport(mobile: boolean) {
  const target = new EventTarget();
  const query = {
    matches: mobile,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  vi.stubGlobal('matchMedia', () => query);
  return (next: boolean) => {
    query.matches = next;
    act(() => target.dispatchEvent(new Event('change')));
  };
}
test('announces counts and new gates, and focuses needs from the header', () => {
  viewport(false);
  const { rerender } = render(<Shell needs={[]} />);
  expect(screen.getByTestId('needs-announcement').textContent).toBe(
    t('app.needs', { count: 0 }),
  );
  rerender(
    <Shell
      needs={[{ id: 'g', title: 'Review', href: '/gates/g' }]}
      newGateTitle="Review"
    />,
  );
  expect(screen.getByTestId('needs-announcement').textContent).toBe(
    t('app.needs', { count: 1 }),
  );
  expect(
    screen.getByTestId('needs-announcement').getAttribute('aria-live'),
  ).toBe('polite');
  expect(screen.getByTestId('gate-announcement').textContent).toBe(
    t('app.newGate', { title: 'Review' }),
  );
  fireEvent.click(screen.getByTestId('needs-button'));
  expect(document.activeElement).toBe(screen.getByTestId('needs-panel'));
  expect(screen.getByTestId('need-g').getAttribute('href')).toBe('/gates/g');
});
test('does not mount the office on mobile, but keeps page, needs and right-column content', () => {
  const resize = viewport(true);
  const office = vi.fn(() => <div data-testid="office" />);
  const Office = office;
  render(
    <Shell office={<Office />} rightColumn={<p data-testid="detail" />}>
      <p data-testid="gate-content" />
    </Shell>,
  );
  expect(office).not.toHaveBeenCalled();
  expect(screen.getByTestId('gate-content')).toBeTruthy();
  expect(screen.getByTestId('needs-panel')).toBeTruthy();
  expect(screen.getByTestId('detail')).toBeTruthy();
  resize(false);
  expect(screen.getByTestId('office')).toBeTruthy();
  resize(true);
  expect(screen.queryByTestId('office')).toBeNull();
});
test('renders stage gates, current view, metadata and usage', () => {
  viewport(false);
  render(
    <Shell
      workflowId="w"
      view="board"
      templateName="Template"
      integrationBranch="integration/test"
      elapsedMinutes={5}
      totalTokens={1000}
      budgetDisabled
      stages={[
        {
          id: 's',
          name: 'Stage',
          status: 'running',
          current: true,
          gates: [{ id: 'g', title: 'Review', href: '/gates/g' }],
        },
      ]}
    />,
  );
  expect(screen.getByTestId('view-board').getAttribute('aria-current')).toBe(
    'page',
  );
  expect(screen.getByTestId('stage-gate-g').getAttribute('href')).toBe(
    '/gates/g',
  );
  expect(screen.getByTestId('token-usage').textContent).toContain('1,000');
  expect(screen.getByTestId('token-usage').textContent).toContain(
    t('office.usage.budgetDisabled'),
  );
});
