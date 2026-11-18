import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import {
  approveStageGates,
  finalPrNumber,
  isEnded,
  readModel,
  startWorkflow,
  until,
  useOffice,
} from '../test-support/index.js';

const office = useOffice({ scenario: 'mainline' });

// Skeleton until the office UI lands (T4/T9): drives the mainline over HTTP
// and checks the UI loads; feature suites replace the HTTP steps with UI ones.
test('mainline reaches the final PR and ends only after an explicit merge', async ({
  page,
}) => {
  await office().login(page);
  await expect(page.locator('#root')).not.toBeEmpty();

  const workflowId = await startWorkflow(office());
  await approveStageGates(office(), workflowId, (_model, open) =>
    open.some((gate) => gate.stageKind === 'final-pr'),
  );
  const number = await until(
    () => finalPrNumber(office(), workflowId),
    (value) => value !== undefined,
    'final PR number',
  );

  // S14: nothing merges the final PR on a timer.
  await delay(1500);
  expect((await readModel(office(), workflowId)).status).toBe('running');

  await office().fake.mergeFinalPr(number!);
  const ended = await until(
    () => readModel(office(), workflowId),
    isEnded,
    'workflow end after the final merge',
  );
  expect(ended.status).toBe('completed');
  // Worker PR numbers are not asserted until FX2 (worker artifact.created).
});
