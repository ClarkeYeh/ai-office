import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { setup, template } from '../../workflows/test-support/setup.js';
import { TemplatesPage } from './TemplatesPage.js';
import { t } from '../../../shared/lib/i18n/index.js';
afterEach(cleanup);
test('detail shows five stages and three gates, scope and timeouts, with a preselection link', async () => {
  const { api } = setup();
  render(<TemplatesPage api={api} route={{ params: { id: 'default' } }} />);
  const link = await screen.findByTestId('template-default');
  expect(link.getAttribute('href')).toBe('/workflows/new?template=default');
  expect(screen.getAllByTestId(/^template-gate-/)).toHaveLength(3);
  for (const stage of template().stages)
    expect(
      screen.getByRole('heading', { name: t(`stage.${stage.kind}`) }),
    ).toBeTruthy();
  expect(screen.getByText(t('templates.gateRequired'))).toBeTruthy();
  expect(screen.getAllByText(t('templates.gateOptional'))).toHaveLength(2);
  expect(screen.getByText(t('templates.sourceUnknown'))).toBeTruthy();
});
test('invalid templates show file and field errors, and refresh reloads edited YAML', async () => {
  const { api } = setup();
  api.listTemplates.mockResolvedValueOnce({
    valid: [],
    invalid: [
      {
        file: 'bad.yaml',
        issues: [{ path: 'stages', message: 'Five stages required' }],
      },
    ],
  });
  render(<TemplatesPage api={api} route={{ params: {} }} />);
  expect((await screen.findByTestId('template-errors')).textContent).toContain(
    'bad.yaml',
  );
  await userEvent.setup().click(screen.getByTestId('templates-refresh'));
  expect(await screen.findByTestId('template-default')).toBeTruthy();
  expect(screen.queryByTestId('template-errors')).toBeNull();
});
