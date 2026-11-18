import type { WorkflowSummary } from '@ai-office/contracts/api';
import type { Translator } from '../../../shared/lib/i18n/index.js';

export function workflowRows(
  workflows: readonly WorkflowSummary[],
  t: Translator,
) {
  return workflows.map((workflow) => ({
    id: workflow.workflowId,
    requirement: workflow.requirement,
    context: `${workflow.repoFullName} · ${workflow.templateName}`,
    status: t(
      workflow.status === 'failed'
        ? 'workflows.failedStatus'
        : `workflows.${workflow.status}`,
    ),
    paused: workflow.pausedReasons.length > 0,
    progress: t('workflows.progress', {
      done: workflow.progress.stagesDone,
      total: workflow.progress.stagesTotal,
    }),
    usage: t('workflows.usage', {
      tokens: workflow.budgetTokens,
      gates: workflow.openGates,
    }),
    stage: workflow.currentStageKind
      ? t(`stage.${workflow.currentStageKind}`)
      : '',
    canCancel: workflow.status === 'running',
    canCleanup: workflow.status !== 'running',
  }));
}
export type WorkflowRow = ReturnType<typeof workflowRows>[number];
