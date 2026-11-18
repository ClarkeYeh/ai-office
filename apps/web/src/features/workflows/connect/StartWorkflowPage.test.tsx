import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { ApiError } from '../../../api/index.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { setup, template, workflow } from '../test-support/setup.js';
import { StartWorkflowPage } from './StartWorkflowPage.js';

afterEach(cleanup);
const failure = (status: number, code: string) =>
  new ApiError(status, {
    code,
    category: 'validation',
    retryable: false,
    message: 'diagnostic',
  });
async function mount() {
  const state = setup();
  render(<StartWorkflowPage api={state.api} />, { wrapper: state.Wrapper });
  const input = await screen.findByTestId('workflow-requirement');
  const user = userEvent.setup();
  await user.type(input, 'Build a keyboard-accessible feature');
  return { ...state, user };
}
test('submits requirement, repo, optional gates and role overrides; locks final PR and Gemini', async () => {
  const { user, api, navigate } = await mount();
  expect(
    (screen.getByTestId('gate-toggle-final-pr') as HTMLInputElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByTestId('gate-toggle-final-pr') as HTMLInputElement).checked,
  ).toBe(true);
  const gemini = screen
    .getByTestId('role-vendor-lead')
    .querySelector('option[value="gemini"]') as HTMLOptionElement;
  expect(gemini.disabled).toBe(true);
  await user.selectOptions(screen.getByTestId('role-vendor-lead'), 'codex');
  await user.selectOptions(screen.getByTestId('role-effort-lead'), 'high');
  await user.click(screen.getByTestId('gate-toggle-conclusion'));
  await user.click(screen.getByTestId('gate-toggle-plan'));
  await user.click(screen.getByTestId('workflow-start'));
  expect(api.startWorkflow).toHaveBeenCalledWith({
    templateId: 'default',
    repoId: 'r1',
    requirement: 'Build a keyboard-accessible feature',
    roleOverrides: { lead: { agent: 'codex', effort: 'high' } },
    gateToggles: { conclusion: false, plan: false },
    acknowledgeUnverifiedRuntime: false,
  });
  expect(navigate).toHaveBeenCalledWith('/workflows/new-workflow');
});
test('409 slot busy disables start, keeps draft, and refresh unlocks when slot is free', async () => {
  const { api, user } = await mount();
  api.startWorkflow.mockRejectedValueOnce(failure(409, 'workflow_slot_busy'));
  await user.click(screen.getByTestId('workflow-start'));
  expect(await screen.findByTestId('workflow-slot-busy')).toBeTruthy();
  expect(
    (screen.getByTestId('workflow-start') as HTMLButtonElement).disabled,
  ).toBe(true);
  await user.click(screen.getByTestId('workflow-refresh'));
  await waitFor(() =>
    expect(
      (screen.getByTestId('workflow-start') as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(
    (screen.getByTestId('workflow-requirement') as HTMLTextAreaElement).value,
  ).toContain('keyboard');
});
test('422 reloads filename and field errors, retaining the entered requirement', async () => {
  const { api, user } = await mount();
  api.startWorkflow.mockRejectedValueOnce(failure(422, 'template_invalid'));
  api.getTemplate.mockResolvedValueOnce({
    valid: [],
    invalid: [
      {
        file: 'broken.yaml',
        issues: [{ path: 'roles.lead.agent', message: 'Invalid agent' }],
      },
    ],
  });
  await user.click(screen.getByTestId('workflow-start'));
  expect((await screen.findByTestId('template-errors')).textContent).toContain(
    'roles.lead.agent',
  );
  expect(screen.getByTestId('workflow-error').textContent).toBe(
    t('workflows.invalid'),
  );
  expect(
    (screen.getByTestId('workflow-requirement') as HTMLTextAreaElement).value,
  ).toContain('keyboard');
});
test('428 requires explicit acknowledgement before resubmitting the same draft', async () => {
  const { api, user, navigate } = await mount();
  api.startWorkflow.mockRejectedValueOnce(failure(428, 'runtime_unverified'));
  await user.click(screen.getByTestId('workflow-start'));
  const checkbox = await screen.findByTestId('workflow-acknowledge');
  expect(
    (screen.getByTestId('workflow-start') as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(navigate).not.toHaveBeenCalled();
  await user.click(checkbox);
  await user.click(screen.getByTestId('workflow-start'));
  expect(api.startWorkflow.mock.calls[1]?.[0]).toMatchObject({
    acknowledgeUnverifiedRuntime: true,
    requirement: 'Build a keyboard-accessible feature',
  });
});
test('live overview blocks start and terminal status releases the slot', async () => {
  const { realtime } = await mount();
  act(() =>
    realtime.store.setState((state) => ({
      overview: { ...state.overview, workflows: [workflow] },
    })),
  );
  expect(screen.getByTestId('workflow-slot-busy')).toBeTruthy();
  act(() =>
    realtime.store.setState((state) => ({
      overview: {
        ...state.overview,
        workflows: [{ ...workflow, status: 'completed' }],
      },
    })),
  );
  expect(screen.queryByTestId('workflow-slot-busy')).toBeNull();
});
test('template link preselects a valid template and switching clears previous overrides', async () => {
  const state = setup();
  const second = { ...template(), id: 'second', name: 'Second' };
  state.api.listTemplates.mockResolvedValue({
    valid: [template(), second],
    invalid: [],
  });
  globalThis.history.replaceState(null, '', '/workflows/new?template=second');
  render(<StartWorkflowPage api={state.api} />, { wrapper: state.Wrapper });
  const select = await screen.findByTestId('workflow-template');
  expect((select as HTMLSelectElement).value).toBe('second');
  const user = userEvent.setup();
  await user.selectOptions(screen.getByTestId('role-vendor-lead'), 'codex');
  await user.click(screen.getByTestId('gate-toggle-conclusion'));
  await user.selectOptions(select, 'default');
  expect(
    (screen.getByTestId('role-vendor-lead') as HTMLSelectElement).value,
  ).toBe('claude-code');
  expect(
    (screen.getByTestId('gate-toggle-conclusion') as HTMLInputElement).checked,
  ).toBe(true);
});
test('unknown errors remain localized and allow retry; empty setup cannot start', async () => {
  const { api, user } = await mount();
  api.startWorkflow.mockRejectedValueOnce(Error('private diagnostic'));
  await user.click(screen.getByTestId('workflow-start'));
  expect((await screen.findByTestId('workflow-error')).textContent).toBe(
    t('workflows.failed'),
  );
  api.listRepos.mockResolvedValueOnce({ repos: [] });
  api.listTemplates.mockResolvedValueOnce({ valid: [], invalid: [] });
  await user.click(screen.getByTestId('workflow-refresh'));
  await screen.findByText(t('workflows.noRepos'));
  expect(
    (screen.getByTestId('workflow-start') as HTMLButtonElement).disabled,
  ).toBe(true);
});
