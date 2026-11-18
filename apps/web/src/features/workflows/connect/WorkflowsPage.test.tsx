import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { setup, workflow } from '../test-support/setup.js';
import { WorkflowsPage } from './WorkflowsPage.js';
afterEach(cleanup);
test('cancel and cleanup require confirmation, report acceptance, and target the chosen workflow', async () => {
  const state = setup();
  state.realtime.store.setState((s) => ({
    overview: {
      ...s.overview,
      workflows: [
        workflow,
        { ...workflow, workflowId: 'finished', status: 'completed' },
      ],
    },
  }));
  render(<WorkflowsPage api={state.api} />, { wrapper: state.Wrapper });
  const user = userEvent.setup();
  await user.click(screen.getByTestId('workflow-cancel-wf1'));
  expect(state.api.cancelWorkflow).not.toHaveBeenCalled();
  await user.click(screen.getByTestId('workflow-dismiss'));
  expect(state.api.cancelWorkflow).not.toHaveBeenCalled();
  await user.click(screen.getByTestId('workflow-cancel-wf1'));
  await user.click(screen.getByTestId('workflow-confirm'));
  expect(state.api.cancelWorkflow).toHaveBeenCalledWith('wf1');
  await user.click(screen.getByTestId('workflow-cleanup-finished'));
  await user.click(screen.getByTestId('workflow-confirm'));
  expect(state.api.cleanupWorkflow).toHaveBeenCalledWith('finished');
});
