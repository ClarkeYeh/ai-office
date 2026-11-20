import { scmTitle } from '@ai-office/domain';
import { metaFor, sessionRef } from '../context.js';
import type { ReactContext } from '../context.js';
import { external, internal } from '../effects.js';
import type { Effect } from '../effects.js';
import { missed } from '../protocols/resume.js';
import { beginStageClose } from '../protocols/stage-close.js';
import type { StageGateBuilder } from '../protocols/stage-close.js';
import { MINUTE_MS, schedule } from '../timers.js';
import {
  stageArtifact,
  remind,
  spawnStageAgent,
  stageAttempts,
  stageCommandId,
  stageTimers,
  stageViolation,
  submitted,
} from './meeting.js';
import type { StageModule } from './types.js';

const gate: StageGateBuilder = (state, stageId) => {
  const config = state.workflow?.template.stages.find((s) => s.id === stageId);
  const stage = state.stages[stageId];
  const proposal = state.proposals[stageId];
  if (config?.kind !== 'planning' || !stage || !proposal) return undefined;
  const submission = state.submissions[proposal.submissionId]!;
  return {
    kind: 'stage',
    gateId: `${state.workflowId}/${stageId}/${stage.attempt}/gate`,
    stageId,
    templateGateId: config.gate.id,
    stageKind: 'planning',
    optional: config.gate.optional ?? false,
    title: config.gate.title,
    options: [],
    content: {
      type: 'work-items',
      artifactId: submission.artifactId ?? submission.id,
    },
  };
};

const reactPlanning: StageModule['react'] = (ctx) => {
  if (
    ![
      'workflow.resumed',
      'stage.started',
      'stage.completed',
      'command.succeeded',
      'seat.status',
      'submission.accepted',
      'workitem.proposed',
      'gate.decided',
      'workitem.approved',
      'timer.fired',
    ].includes(ctx.event.type)
  )
    return [];
  const workflow = ctx.state.workflow;
  const config = workflow?.template.stages.find((s) => s.kind === 'planning');
  if (!workflow || config?.kind !== 'planning') return [];
  const stageId = config.id;
  const wake =
    ctx.event.type === 'workflow.resumed' ||
    (ctx.event.type === 'gate.decided' &&
      ctx.state.gates[ctx.event.payload.gateId]?.stageId === stageId &&
      ['top-up', 'top-up-rerun'].includes(ctx.event.payload.optionId ?? ''));
  const stage = ctx.state.stages[stageId]!;
  if (ctx.event.type === 'gate.decided' && !wake) {
    const decided = ctx.state.gates[ctx.event.payload.gateId];
    if (
      decided?.kind !== 'stage' ||
      decided.stageId !== stageId ||
      !['approve', 'revise'].includes(ctx.event.payload.decision)
    )
      return [];
    const items =
      ctx.event.payload.edits?.type === 'work-items'
        ? ctx.event.payload.edits.items
        : ctx.state.proposals[stageId]!.items;
    return [
      internal({
        type: 'ApproveWorkItems',
        meta: metaFor(ctx),
        gateId: decided.gateId,
        items: items.map((item) => ({
          ...item,
          agent:
            item.agent ??
            workflow.roleOverrides[item.role]?.agent ??
            workflow.template.roles[item.role]!.agent,
        })),
      }),
    ];
  }
  if (
    ctx.event.type === 'workitem.approved' &&
    ctx.state.gates[ctx.event.payload.gateId]?.stageId === stageId
  )
    return ctx.event.payload.items.map((item) => {
      const id = stageCommandId(ctx, stageId, 'issue', item.key);
      return external(
        id,
        {
          kind: 'scm.createIssue',
          args: {
            repo: workflow.repo.github,
            title: scmTitle(item.title),
            body: `${item.body}\n\n## Acceptance\n${item.acceptance.map((a) => `- ${a}`).join('\n')}\n\nDependencies: ${item.deps.join(', ')}\n\n<!-- ai-office:cmd=${id} -->`,
            labels: [
              'ai-office:work-item',
              `agent:${item.agent}`,
              `role:${item.role}`,
            ],
          },
        },
        { stageId },
      );
    });
  if (
    ctx.event.type === 'stage.completed' &&
    ctx.event.payload.stageId === stageId
  )
    return [
      ...stageTimers(ctx, stageId),
      ...beginStageClose(ctx, stageId, gate),
    ];
  if (
    stage.status !== 'running' ||
    workflow.cancelRequested ||
    workflow.pausedReasons.length ||
    ctx.state.gates[stageCommandId(ctx, stageId, 'violation')]
  )
    return [];
  const attempts = stageAttempts(ctx.state, stageId);
  const lead = attempts.find((a) => a.purpose === 'planner');
  const effects: Effect[] = [];
  if (
    ctx.event.type === 'stage.started' &&
    ctx.event.payload.stageId === stageId
  )
    effects.push(
      schedule(
        ctx,
        { purpose: 'stage-timeout', stageId, attempt: stage.attempt },
        config.timeouts.stageMin * MINUTE_MS,
      ),
    );
  if (
    !lead &&
    sessionRef(ctx.state) &&
    (wake ||
      (ctx.event.type === 'stage.started' &&
        ctx.event.payload.stageId === stageId) ||
      (ctx.event.type === 'command.succeeded' &&
        ctx.event.payload.kind === 'runtime.openSession'))
  ) {
    const suffix = stage.attempt > 1 ? `-a${stage.attempt}` : '';
    return [
      ...effects,
      ...spawnStageAgent(
        ctx,
        config.owner,
        { purpose: 'planner', stageId },
        {
          kind: 'new-worktree',
          baseBranch: workflow.repo.defaultBranch,
          name: `aio-${workflow.shortId}-planning${suffix}`,
          branch: `ai-office/${workflow.shortId}/planning${suffix}`,
        },
        false,
      ),
    ];
  }
  if (!lead) return effects;
  const submission = submitted(ctx.state, lead, 'work-items');
  if (
    ctx.event.type === 'submission.accepted' &&
    ctx.event.payload.attemptId === lead.attemptId &&
    submission?.submission.kind === 'work-items'
  )
    return [
      internal({
        type: 'ProposeWorkItems',
        meta: metaFor(ctx),
        stageId,
        submissionId: submission.id,
        items: submission.submission.payload.items,
      }),
    ];
  if (
    ctx.event.type === 'workitem.proposed' &&
    ctx.event.payload.stageId === stageId
  )
    return [
      internal({
        type: 'CompleteStage',
        meta: metaFor(ctx),
        stageId,
        attempt: stage.attempt,
      }),
    ];
  const timeout =
    ctx.timer?.payload.purpose === 'stage-timeout' &&
    ctx.timer.payload.stageId === stageId &&
    ctx.timer.payload.attempt === stage.attempt;
  if (!submission && timeout && ctx.timer!.id.includes('/grace/'))
    return stageViolation(ctx, stageId, 'Missing work-items submission');
  if (!submission && (timeout || lead.state === 'done'))
    return remind(
      ctx,
      lead,
      'work-items',
      { purpose: 'stage-timeout', stageId, attempt: stage.attempt },
      5 * MINUTE_MS,
    );
  return effects;
};
/** A work-items submission or proposal reached while paused (§16). */
const resume = (ctx: ReactContext) => {
  const config = ctx.state.workflow!.template.stages.find(
    (s) => s.kind === 'planning',
  );
  if (config?.kind !== 'planning') return [];
  const stageId = config.id;
  if (ctx.state.stages[stageId]?.status !== 'running') return [];
  const lead = stageAttempts(ctx.state, stageId).find(
    (a) => a.purpose === 'planner',
  );
  const submission = submitted(ctx.state, lead, 'work-items');
  if (!submission) return [];
  const proposal = ctx.state.proposals[stageId];
  if (proposal?.submissionId === submission.id)
    return [missed(ctx, 'workitem.proposed', proposal, { stageId })];
  return [
    missed(
      ctx,
      'submission.accepted',
      {
        submissionId: submission.id,
        attemptId: submission.attemptId,
        kind: submission.kind,
        submission: submission.submission,
        ...(submission.artifactId === undefined
          ? {}
          : { artifactId: submission.artifactId }),
      },
      { stageId, attemptId: submission.attemptId },
    ),
  ];
};

export const planningStage: StageModule = {
  stageGate: gate,
  resume,
  react: (ctx) => {
    const stage = ctx.state.workflow?.template.stages.find(
      (s) => s.kind === 'planning',
    );
    return [
      ...(stage ? stageArtifact(ctx, stage.id) : []),
      ...reactPlanning(ctx),
    ];
  },
};
