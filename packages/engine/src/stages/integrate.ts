import { possiblyLiveAttempts } from '@ai-office/domain';
import { releaseAttempt, stopAttempt } from '../agents.js';
import { metaFor, sessionRef } from '../context.js';
import { external, internal } from '../effects.js';
import type { Effect } from '../effects.js';
import { MINUTE_MS, schedule } from '../timers.js';
import {
  remind,
  spawnStageAgent,
  stageAttempts,
  stageCommandId,
  stageTimers,
  stageViolation,
  submitted,
} from './meeting.js';
import type { StageModule } from './types.js';

export const integrateStage: StageModule = {
  react: (ctx) => {
    const workflow = ctx.state.workflow;
    const config = workflow?.template.stages.find(
      (s) => s.kind === 'integrate',
    );
    if (
      !workflow ||
      config?.kind !== 'integrate' ||
      workflow.status !== 'running' ||
      workflow.cancelRequested ||
      workflow.pausedReasons.length
    )
      return [];
    const stageId = config.id;
    const stage = ctx.state.stages[stageId]!;
    // Integrate is already done when final-pr requests a revision; lifecycle's
    // first-not-done traversal deliberately does not pick it up.
    if (
      ctx.event.type === 'stage.rerun_requested' &&
      ctx.event.payload.stageId === stageId &&
      stage.pendingRerun &&
      stage.status === 'done'
    )
      return [internal({ type: 'StartStage', meta: metaFor(ctx), stageId })];
    if (stage.status !== 'running') return [];
    if (ctx.state.gates[stageCommandId(ctx, stageId, 'violation')]) return [];
    const live = possiblyLiveAttempts(ctx.state);
    const integrator = stageAttempts(ctx.state, stageId).find(
      (a) => a.purpose === 'integrator',
    );
    const report = submitted(ctx.state, integrator, 'integration-report');
    if (report) {
      if (
        ctx.timer?.payload.purpose === 'stage-timeout' &&
        ctx.timer.payload.stageId === stageId &&
        ctx.timer.payload.attempt === stage.attempt &&
        live.length
      )
        return stageViolation(ctx, stageId, 'Wrap-up agents did not stop');
      const effects: Effect[] = [];
      if (
        ctx.event.type === 'submission.accepted' &&
        ctx.event.payload.submissionId === report.id
      ) {
        effects.push(
          internal({
            type: 'RecordStageArtifact',
            meta: metaFor(ctx),
            stageId,
            artifact: {
              kind: 'integration-report',
              artifactId: report.artifactId ?? report.id,
              submissionId: report.id,
              attemptId: integrator!.attemptId,
            },
          }),
        );
      }
      if (
        live.length === 0 &&
        (ctx.event.type === 'submission.accepted' ||
          possiblyLiveAttempts(ctx.before).length > 0) &&
        [
          'submission.accepted',
          'seat.exited',
          'seat.released',
          'seat.status',
        ].includes(ctx.event.type)
      )
        return [
          ...effects,
          ...stageTimers(ctx, stageId),
          internal({
            type: 'CompleteStage',
            meta: metaFor(ctx),
            stageId,
            attempt: stage.attempt,
          }),
        ];
      if (
        ctx.event.type === 'submission.accepted' ||
        (ctx.event.type === 'command.succeeded' &&
          ctx.event.payload.kind === 'runtime.spawnAgent')
      )
        effects.push(
          ...live.flatMap((a) => [
            ...stopAttempt(ctx, a, 'wrap-up'),
            ...releaseAttempt(
              ctx,
              a,
              a.attemptId === integrator?.attemptId,
              'wrap-up',
            ),
          ]),
        );
      return effects;
    }
    if (
      ctx.event.type === 'submission.accepted' &&
      ctx.event.payload.attemptId === integrator?.attemptId &&
      ctx.event.payload.submission.kind === 'decision-request'
    ) {
      const request = ctx.event.payload.submission.payload;
      return [
        internal({
          type: 'OpenGate',
          meta: metaFor(ctx),
          noLiveAttempts: false,
          gate: {
            kind: 'exception',
            gateId: stageCommandId(
              ctx,
              stageId,
              'decision',
              ctx.event.payload.submissionId,
            ),
            stageId,
            exceptionKind: 'decision-request',
            title: request.question,
            options: [
              ...(request.options.length ? request.options : ['Continue']).map(
                (label, i) => ({ optionId: `choice-${i + 1}`, label }),
              ),
              { optionId: 'abort', label: 'Abort workflow' },
            ],
            content: {
              type: 'exception',
              summary: request.question,
              attemptId: integrator.attemptId,
            },
          },
        }),
      ];
    }
    if (ctx.event.type === 'gate.decided') {
      const decision = ctx.event.payload;
      const gate = ctx.state.gates[ctx.event.payload.gateId];
      if (
        gate?.stageId === stageId &&
        gate.kind === 'exception' &&
        gate.exceptionKind === 'decision-request' &&
        ctx.event.payload.optionId !== 'abort' &&
        integrator?.agentRef
      )
        return [
          external(
            stageCommandId(ctx, stageId, 'answer', gate.gateId),
            {
              kind: 'runtime.send',
              args: {
                agent: integrator.agentRef,
                subject: 'Wrap-up decision',
                body: `${gate.options.find((o) => o.optionId === decision.optionId)?.label ?? ''}\n${ctx.event.payload.comment ?? ''}`,
              },
            },
            { stageId, attemptId: integrator.attemptId },
          ),
        ];
    }
    const timeout =
      ctx.timer?.payload.purpose === 'stage-timeout' &&
      ctx.timer.payload.stageId === stageId &&
      ctx.timer.payload.attempt === stage.attempt;
    if (timeout && ctx.timer!.id.includes('/grace/'))
      return stageViolation(ctx, stageId, 'Missing integration-report');
    if (
      integrator &&
      (timeout ||
        (ctx.event.type === 'seat.status' && integrator.state === 'done'))
    )
      return remind(
        ctx,
        integrator,
        'integration-report',
        { purpose: 'stage-timeout', stageId, attempt: stage.attempt },
        5 * MINUTE_MS,
      );
    if (integrator) return [];
    if (
      ![
        'stage.started',
        'command.succeeded',
        'seat.exited',
        'seat.released',
      ].includes(ctx.event.type)
    )
      return [];
    if (
      Object.values(ctx.state.workItems).some(
        (item) => !['merged', 'skipped', 'failed'].includes(item.status),
      )
    )
      return stageViolation(
        ctx,
        stageId,
        'Wrap-up requires every work item merged or explicitly disposed',
      );
    if (live.length)
      return live.flatMap((a) => [
        ...stopAttempt(ctx, a, 'before-wrap-up'),
        ...releaseAttempt(ctx, a, false, 'before-wrap-up'),
      ]);
    const session = sessionRef(ctx.state);
    if (!session) return [];
    const workspaceId = stageCommandId(ctx, stageId, 'workspace');
    const prepared = ctx.state.commands[workspaceId]?.result;
    if (
      prepared?.kind === 'runtime.prepareWorkspace' &&
      prepared.result &&
      'workspace' in prepared.result
    )
      return [
        ...spawnStageAgent(
          ctx,
          config.owner,
          { purpose: 'integrator', stageId },
          {
            kind: 'existing-worktree',
            workspace: prepared.result.workspace,
            readOnly: false,
          },
          false,
        ),
        schedule(
          ctx,
          { purpose: 'stage-timeout', stageId, attempt: stage.attempt },
          config.timeouts.stageMin * MINUTE_MS,
        ),
      ];
    if (ctx.state.commands[workspaceId]) return [];
    return [
      external(
        workspaceId,
        {
          kind: 'runtime.prepareWorkspace',
          args: {
            session,
            repo: {
              orcaRepoId: workflow.repo.orcaRepoId,
              localPath: workflow.repo.localPath,
            },
            baseBranch: `origin/${workflow.integrationBranch}`,
            fetchBranch: workflow.integrationBranch,
            branch: workflow.integrationBranch,
            checkoutExisting: true,
            name: `aio-${workflow.shortId}-wrap-up-r${stage.attempt}`,
          },
        },
        { stageId },
      ),
    ];
  },
};
