import { expect, test } from 'vitest';
import { t } from '../../../shared/lib/i18n/index.js';
import { workflow } from '../test-support/setup.js';
import { workflowRows } from './workflows.js';
test('running and paused workflows can cancel; every terminal status can clean up', () => {
  const rows = workflowRows(
    [
      { ...workflow, pausedReasons: ['runtime_unhealthy'] },
      { ...workflow, status: 'completed', currentStageKind: null },
      { ...workflow, status: 'failed' },
      { ...workflow, status: 'cancelled' },
    ],
    t,
  );
  expect(rows.map((row) => [row.canCancel, row.canCleanup])).toEqual([
    [true, false],
    [false, true],
    [false, true],
    [false, true],
  ]);
  expect(rows[0]).toMatchObject({
    paused: true,
    stage: t('stage.meeting'),
    progress: t('workflows.progress', { done: 0, total: 5 }),
    usage: t('workflows.usage', { tokens: 1234, gates: 1 }),
  });
  expect(rows[1]?.stage).toBe('');
  expect(rows[2]?.status).toBe(t('workflows.failedStatus'));
});
