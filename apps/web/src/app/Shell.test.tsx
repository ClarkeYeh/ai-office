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
test('stage strip: checks on done stages and decided gates, flags on the rest (V3)', () => {
  viewport(false);
  render(
    <Shell
      workflowId="w"
      stages={[
        {
          id: 'meeting',
          name: 'Meeting',
          status: 'done',
          gate: { id: 'conclusion', title: 'Conclusion', state: 'done' },
        },
        {
          id: 'planning',
          name: 'Planning',
          status: 'awaiting_gate',
          current: true,
          gate: {
            id: 'plan',
            title: 'Task split',
            state: 'open',
            gateId: 'g-plan',
            href: '/gates/g-plan',
          },
        },
        {
          id: 'final',
          name: 'Final PR',
          status: 'pending',
          gateOnly: true,
          gate: { id: 'final-pr', title: 'Final PR', state: 'pending' },
        },
      ]}
    />,
  );
  const strip = screen.getByRole('navigation', { name: t('app.stages') });
  expect(strip.textContent).toContain(t('app.flow'));
  const meeting = screen.getByTestId('stage-meeting');
  expect(meeting.dataset.status).toBe('done');
  expect(meeting.getAttribute('aria-label')).toBe(
    t('stage.aria', { name: 'Meeting', status: t('stage.done') }),
  );
  expect(screen.getByTestId('stage-flag-conclusion').dataset.state).toBe(
    'done',
  );
  const open = screen.getByTestId('stage-gate-g-plan');
  expect(open.getAttribute('href')).toBe('/gates/g-plan');
  expect(open.getAttribute('aria-label')).toBe(
    t('stage.gate.open', { title: 'Task split' }),
  );
  // The final-PR stage is its gate: one chip, no separate stage label.
  expect(screen.queryByTestId('stage-final')).toBeNull();
  expect(screen.getByTestId('stage-flag-final-pr').dataset.state).toBe(
    'pending',
  );
  const icon = (id: string) =>
    screen.getByTestId(id).querySelector('path')?.getAttribute('d');
  // Done stage and decided gate share the check; pending and open show the flag.
  expect(icon('stage-meeting')).toBe(icon('stage-flag-conclusion'));
  expect(icon('stage-flag-final-pr')).toBe(icon('stage-gate-g-plan'));
  expect(icon('stage-meeting')).not.toBe(icon('stage-flag-final-pr'));
  expect(screen.getByTestId('stage-planning').querySelector('path')).toBeNull();
});
