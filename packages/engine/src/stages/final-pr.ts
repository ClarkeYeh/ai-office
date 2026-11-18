import type { WorkflowState } from '@ai-office/domain';
import { metaFor } from '../context.js';
import { external, internal } from '../effects.js';
import type { ReactContext } from '../context.js';
import { missed, missedResult } from '../protocols/resume.js';
import { beginStageClose } from '../protocols/stage-close.js';
import type { StageGateBuilder } from '../protocols/stage-close.js';
import { pendingTimers } from '../timers.js';
import { stageAttempts, stageCommandId, submitted } from './meeting.js';
import type { StageModule } from './types.js';

const reportFor = (state: WorkflowState) => {
  const stage = Object.values(state.stages).find((s) => s.kind === 'integrate');
  return (
    stage &&
    submitted(
      state,
      stageAttempts(state, stage.id).find((a) => a.purpose === 'integrator'),
      'integration-report',
    )
  );
};

const gate: StageGateBuilder = (state, stageId) => {
  const workflow = state.workflow!;
  const config = workflow.template.stages.find((s) => s.id === stageId);
  const integrate = Object.values(state.stages).find(
    (s) => s.kind === 'integrate',
  );
  const report = reportFor(state);
  if (
    config?.kind !== 'final-pr' ||
    !report ||
    !workflow.finalPr ||
    integrate?.status !== 'done'
  )
    return undefined;
  return {
    kind: 'stage',
    gateId: `${workflow.id}/${stageId}/gate/${integrate.attempt}`,
    stageId,
    templateGateId: config.gate.id,
    stageKind: 'final-pr',
    optional: false,
    title: config.gate.title,
    options: [
      ...(integrate.revisions < config.maxRevisions
        ? [{ optionId: 'request-changes', label: 'Request changes' }]
        : []),
      { optionId: 'keep-open', label: 'Keep open for manual handling' },
      { optionId: 'abort', label: 'Abort workflow' },
    ],
    content: {
      type: 'final-pr',
      artifactId: report.artifactId ?? report.id,
      pr: workflow.finalPr,
    },
  };
};

const bodyFor = (state: WorkflowState, marker: string): string => {
  const report = reportFor(state)!;
  if (report.submission.kind !== 'integration-report') return '';
  const payload = report.submission.payload;
  const conclusion = Object.values(state.gates).find(
    (g) =>
      g.kind === 'stage' &&
      g.stageKind === 'meeting' &&
      ['approved', 'revised'].includes(g.status),
  );
  const issue = Object.values(state.artifacts).find(
    (a) => a.kind === 'issue' && a.purpose === 'conclusion',
  );
  return [
    payload.summary,
    '## Conclusion',
    issue?.kind === 'issue' ? issue.url : '',
    '## Technical decisions',
    JSON.stringify(
      conclusion?.decision?.approvedSnapshot?.structured ??
        conclusion?.decision?.approvedSnapshot?.body ??
        {},
      null,
      2,
    ),
    '## Work items',
    ...state.workItemOrder
      .map((key) => state.workItems[key]!)
      .flatMap((item) => [
        `- ${item.key}: ${item.title} (${item.status})${item.pr ? ` — worker PR #${item.pr}` : ''}`,
        ...(item.issue && item.status === 'merged'
          ? [`Closes #${item.issue}`]
          : []),
      ]),
    '## Verification',
    ...payload.verification.map((v) => `- [${v.ok ? 'x' : ' '}] ${v.command}`),
    '## Risks',
    ...payload.risks.map((risk) => `- ${risk}`),
    `<!-- ai-office:workflow=${state.workflowId} -->`,
    `<!-- ai-office:cmd=${marker} -->`,
  ].join('\n\n');
};

/**
 * Publication steps reached while paused (§16): the final PR opened, updated
 * or recorded, the stage completed, or the PR observed merged.
 */
const resume = (ctx: ReactContext) => {
  const workflow = ctx.state.workflow!;
  const config = workflow.template.stages.find((s) => s.kind === 'final-pr');
  const integrate = Object.values(ctx.state.stages).find(
    (s) => s.kind === 'integrate',
  );
  if (config?.kind !== 'final-pr' || integrate?.status !== 'done') return [];
  const stageId = config.id;
  const stage = ctx.state.stages[stageId]!;
  const gates = Object.values(ctx.state.gates).filter(
    (g) => g.stageId === stageId && g.kind === 'stage',
  );
  const merged = gates.find(
    (g) => g.status === 'closed' && g.closedReason === 'merged',
  );
  if (merged)
    return [
      missed(
        ctx,
        'gate.closed',
        { gateId: merged.gateId, reason: 'merged' },
        { stageId },
      ),
    ];
  const id = stageCommandId(ctx, stageId, 'publish', integrate.attempt);
  const record = ctx.state.commands[id];
  const closing =
    gates.some((g) => g.gateId === gate(ctx.state, stageId)?.gateId) ||
    pendingTimers(ctx.state, 'gate-precheck').some(
      (t) => t.payload.stageId === stageId,
    );
  const pr = workflow.finalPr && ctx.state.prs[String(workflow.finalPr)];
  const artifact = ctx.state.artifacts[id];
  const events = [];
  if (!record && stage.status === 'running')
    events.push(
      missed(
        ctx,
        'stage.started',
        {
          stageId,
          kind: 'final-pr',
          attempt: stage.attempt,
          mode: stage.mode ?? 'initial',
        },
        { stageId },
      ),
    );
  if (!record && stage.status === 'awaiting_gate')
    events.push(
      missed(
        ctx,
        'stage.completed',
        { stageId: integrate.id, attempt: integrate.attempt },
        { stageId: integrate.id },
      ),
    );
  if (
    record?.result &&
    (record.issued.kind === 'scm.openPR' ? !artifact : !closing)
  )
    events.push(missedResult(ctx, id, stageId)!);
  if (artifact && stage.status === 'running') {
    const payload: Partial<typeof artifact> = { ...artifact };
    delete payload.createdAt;
    events.push(
      missed(ctx, 'artifact.created', payload as typeof artifact, { stageId }),
    );
  }
  if (
    record?.issued.kind === 'scm.openPR' &&
    stage.status === 'awaiting_gate' &&
    !closing
  )
    events.push(
      missed(
        ctx,
        'stage.completed',
        { stageId, attempt: stage.attempt },
        { stageId },
      ),
    );
  if (pr) events.push(missed(ctx, 'pr.status', pr, { stageId }));
  return events;
};

export const finalPrStage: StageModule = {
  stageGate: gate,
  resume,
  react: (ctx) => {
    const workflow = ctx.state.workflow;
    const config = workflow?.template.stages.find((s) => s.kind === 'final-pr');
    const integrate = Object.values(ctx.state.stages).find(
      (s) => s.kind === 'integrate',
    );
    if (
      !workflow ||
      config?.kind !== 'final-pr' ||
      !integrate ||
      workflow.status !== 'running' ||
      workflow.cancelRequested ||
      workflow.pausedReasons.length
    )
      return [];
    const stageId = config.id;
    const stage = ctx.state.stages[stageId]!;
    const event = ctx.event;
    if (event.type === 'gate.closed' && event.payload.reason === 'merged') {
      const closed = ctx.state.gates[event.payload.gateId];
      if (
        closed?.stageId !== stageId ||
        !workflow.finalPr ||
        integrate.status !== 'done'
      )
        return [];
      const sha = ctx.state.prs[String(workflow.finalPr)]?.mergeCommitSha;
      return [
        internal({
          type: 'CompleteWorkflow',
          meta: metaFor(ctx),
          finalPr: workflow.finalPr,
          ...(sha ? { mergeCommitSha: sha } : {}),
        }),
      ];
    }
    if (integrate.status !== 'done' || !reportFor(ctx.state) || !stage.attempt)
      return [];
    if (event.type === 'pr.status' || event.type === 'gate.opened') {
      const active = Object.values(ctx.state.gates).find(
        (g) =>
          g.stageId === stageId &&
          g.kind === 'stage' &&
          (g.status === 'open' ||
            (g.status === 'approved' && g.decision?.optionId === 'keep-open')),
      );
      if (
        active &&
        workflow.finalPr &&
        ctx.state.prs[String(workflow.finalPr)]?.state === 'merged'
      )
        return [
          internal({
            type: 'CloseGate',
            meta: metaFor(ctx),
            gateId: active.gateId,
            reason: 'merged',
          }),
        ];
    }
    const id = stageCommandId(ctx, stageId, 'publish', integrate.attempt);
    if (
      (event.type === 'stage.started' && event.payload.stageId === stageId) ||
      (event.type === 'stage.completed' &&
        event.payload.stageId === integrate.id &&
        stage.status === 'awaiting_gate')
    ) {
      const body = bodyFor(ctx.state, id);
      if (workflow.finalPr)
        return [
          external(
            id,
            {
              kind: 'scm.updatePR',
              args: {
                pr: { repo: workflow.repo.github, number: workflow.finalPr },
                patch: { body },
              },
            },
            { stageId },
          ),
          external(
            `${id}/comment`,
            {
              kind: 'scm.comment',
              args: {
                target: {
                  type: 'pr',
                  repo: workflow.repo.github,
                  number: workflow.finalPr,
                },
                body: `Wrap-up revision ${integrate.revisions} completed.\n\n${reportFor(ctx.state)!.submission.kind === 'integration-report' ? body : ''}`,
              },
            },
            { stageId },
          ),
        ];
      return [
        external(
          id,
          {
            kind: 'scm.openPR',
            args: {
              repo: workflow.repo.github,
              title: workflow.requirement,
              body,
              head: workflow.integrationBranch,
              base: workflow.repo.defaultBranch,
            },
          },
          { stageId },
        ),
      ];
    }
    if (event.type === 'command.succeeded' && event.payload.commandId === id) {
      if (event.payload.kind === 'scm.openPR')
        return [
          internal({
            type: 'RecordStageArtifact',
            meta: metaFor(ctx),
            stageId,
            commandId: id,
            artifact: {
              kind: 'pr',
              artifactId: id,
              number: event.payload.result.pr,
              url: event.payload.result.url,
              purpose: 'final',
              head: workflow.integrationBranch,
              base: workflow.repo.defaultBranch,
            },
          }),
        ];
      if (event.payload.kind === 'scm.updatePR')
        return beginStageClose(ctx, stageId, gate);
    }
    if (
      event.type === 'artifact.created' &&
      event.payload.kind === 'pr' &&
      event.payload.purpose === 'final' &&
      stage.status === 'running'
    )
      return [
        internal({
          type: 'CompleteStage',
          meta: metaFor(ctx),
          stageId,
          attempt: stage.attempt,
        }),
      ];
    if (event.type === 'stage.completed' && event.payload.stageId === stageId)
      return beginStageClose(ctx, stageId, gate);
    return [];
  },
};
