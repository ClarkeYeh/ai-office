import { seatIdFor } from '@ai-office/contracts/events';
import type { Conclusion } from '@ai-office/contracts/events';
import type { Attempt, SpecRequest, WorkflowState } from '@ai-office/domain';
import { releaseAttempt, stopAttempt } from '../agents.js';
import { commandId, metaFor, sessionRef } from '../context.js';
import type { ReactContext } from '../context.js';
import { external, internal } from '../effects.js';
import type { Effect, SpawnEffect } from '../effects.js';
import { STAGE_VIOLATION_OPTIONS } from '../protocols/nudge.js';
import { beginStageClose } from '../protocols/stage-close.js';
import type { StageGateBuilder } from '../protocols/stage-close.js';
import { cancelTimer, MINUTE_MS, schedule } from '../timers.js';
import type { StageModule } from './types.js';

/** Stable ids include the stage attempt, so a rejection never reuses an old command. */
export const stageCommandId = (
  ctx: ReactContext,
  stageId: string,
  ...parts: (string | number)[]
): string =>
  commandId(ctx, stageId, ctx.state.stages[stageId]!.attempt, ...parts);

export const stageAttempts = (
  state: WorkflowState,
  stageId: string,
): Attempt[] =>
  Object.values(state.attempts).filter(
    (a) =>
      a.stageId === stageId &&
      a.stageAttempt === state.stages[stageId]?.attempt,
  );

export const submitted = (
  state: WorkflowState,
  attempt: Attempt | undefined,
  kind: keyof Attempt['submissions'],
) => {
  const id = attempt?.submissions[kind];
  return id === undefined ? undefined : state.submissions[id];
};

/** Spawn metadata is decided first; only application may materialize the secret spec. */
export const spawnStageAgent = (
  ctx: ReactContext,
  role: string,
  // Merge-queue instances are on-demand (§7.5); T14b spawns them with `ondemand`.
  spec: Exclude<SpecRequest, { purpose: 'merge-queue' }>,
  workspace: SpawnEffect['workspace'],
  keepOpen: boolean,
): Effect[] => {
  const stage = ctx.state.stages[spec.stageId]!;
  const workflow = ctx.state.workflow!;
  const config = workflow.template.roles[role]!;
  const override = workflow.roleOverrides[role];
  const attemptId = stageCommandId(ctx, stage.id, 'attempt', role);
  const id = stageCommandId(ctx, stage.id, 'spawn', role);
  const agent = stage.agentOverride ?? override?.agent ?? config.agent;
  const effort = override?.effort ?? config.effort;
  return [
    internal({
      type: 'SpawnAttempt',
      meta: metaFor(ctx),
      stageId: stage.id,
      role,
      attemptId,
      purpose: spec.purpose,
      keepOpen,
      spawnCommandId: id,
      agent,
      ...(effort === undefined ? {} : { effort }),
    }),
    {
      kind: 'spawn',
      commandId: id,
      stageId: stage.id,
      seatId: seatIdFor({ workflowId: ctx.workflowId, role }),
      attemptId,
      spec,
      agent,
      ...(effort === undefined ? {} : { effort }),
      workspace,
      keepOpen,
    },
  ];
};

export const stageViolation = (
  ctx: ReactContext,
  stageId: string,
  summary: string,
  changedFiles?: string[],
): Effect[] => {
  const gateId = stageCommandId(ctx, stageId, 'violation');
  if (ctx.state.gates[gateId]) return [];
  return [
    ...stageAttempts(ctx.state, stageId).flatMap((a) =>
      a.released
        ? []
        : [
            ...stopAttempt(ctx, a, 'violation'),
            ...releaseAttempt(ctx, a, false, 'violation'),
          ],
    ),
    ...stageTimers(ctx, stageId),
    internal({
      type: 'OpenGate',
      meta: metaFor(ctx),
      noLiveAttempts: false,
      gate: {
        kind: 'exception',
        gateId,
        stageId,
        exceptionKind: 'stage-violation',
        title: '階段違約',
        options: STAGE_VIOLATION_OPTIONS,
        content: {
          type: 'exception',
          summary,
          ...(changedFiles === undefined ? {} : { changedFiles }),
        },
      },
    }),
  ];
};

export const stageTimers = (ctx: ReactContext, stageId: string): Effect[] =>
  Object.values(ctx.state.timers)
    .filter(
      (t) =>
        ('stageId' in t.payload &&
          t.payload.stageId === stageId &&
          t.payload.purpose !== 'gate-precheck') ||
        ('attemptId' in t.payload &&
          t.payload.attemptId !== undefined &&
          ctx.state.attempts[t.payload.attemptId]?.stageId === stageId),
    )
    .map((t) => cancelTimer(t.id, 'stage_ended'));

/** A per-turn reminder. The command ledger, not attempt-wide nudge flags, deduplicates it. */
export const remind = (
  ctx: ReactContext,
  attempt: Attempt,
  turn: string,
  payload: Parameters<typeof schedule>[1],
  delay: number,
): Effect[] => {
  const id = stageCommandId(
    ctx,
    attempt.stageId,
    'nudge',
    turn,
    attempt.attemptId,
  );
  if (!attempt.agentRef || ctx.state.commands[id]) return [];
  return [
    external(
      id,
      {
        kind: 'runtime.send',
        args: {
          agent: attempt.agentRef,
          subject: 'Required turn output',
          body: `Complete ${turn}: submit the required artifact, then report worker_done. Five-minute grace.`,
        },
      },
      { stageId: attempt.stageId, attemptId: attempt.attemptId },
    ),
    internal({
      type: 'RecordNudge',
      meta: metaFor(ctx),
      attemptId: attempt.attemptId,
      reason: 'missing-submission',
      subject: 'Required turn output',
      body: `Missing ${turn} output or worker_done`,
    }),
    schedule(ctx, payload, delay, 'grace', turn, attempt.attemptId),
  ];
};

export const renderMeetingConclusion = (conclusion: Conclusion): string =>
  [
    '# Meeting conclusion',
    ...(
      ['summary', 'decisions', 'techDecisions', 'openQuestions'] as const
    ).flatMap((key) => [
      '',
      `<!-- ai-office:${key}:start -->`,
      `## ${key}`,
      JSON.stringify(conclusion[key], null, 2),
      `<!-- ai-office:${key}:end -->`,
    ]),
  ].join('\n');

const gate: StageGateBuilder = (state, stageId) => {
  const config = state.workflow?.template.stages.find((s) => s.id === stageId);
  const stage = state.stages[stageId];
  const conclusion = submitted(
    state,
    stageAttempts(state, stageId).find((a) => a.purpose === 'facilitator'),
    'conclusion',
  );
  if (
    config?.kind !== 'meeting' ||
    !stage ||
    conclusion?.submission.kind !== 'conclusion'
  )
    return undefined;
  const issueId = `${state.workflowId}/${stageId}/${stage.attempt}/issue`;
  const issued = state.commands[issueId]?.issued;
  if (issued?.kind !== 'scm.createIssue') return undefined;
  return {
    kind: 'stage',
    gateId: `${state.workflowId}/${stageId}/${stage.attempt}/gate`,
    stageId,
    templateGateId: config.gate.id,
    stageKind: 'meeting',
    optional: config.gate.optional ?? false,
    title: config.gate.title,
    options: [],
    content: {
      type: 'conclusion',
      artifactId: conclusion.artifactId ?? conclusion.id,
      renderedHash: conclusionHash(issued.args.body),
    },
  };
};

/** Persist submission/SCM links for gate details and later stages. */
export const stageArtifact = (ctx: ReactContext, stageId: string): Effect[] => {
  const event = ctx.event;
  if (
    event.type === 'submission.accepted' &&
    ctx.state.attempts[event.payload.attemptId]?.stageId === stageId
  ) {
    const p = event.payload;
    if (['agenda', 'statement', 'conclusion', 'work-items'].includes(p.kind))
      return [
        internal({
          type: 'RecordStageArtifact',
          meta: metaFor(ctx),
          stageId,
          artifact: {
            artifactId: p.artifactId ?? p.submissionId,
            kind: p.kind as
              'agenda' | 'statement' | 'conclusion' | 'work-items',
            submissionId: p.submissionId,
            attemptId: p.attemptId,
          },
        }),
      ];
  }
  if (
    event.type === 'command.succeeded' &&
    event.payload.kind === 'scm.createIssue' &&
    event.stageId === stageId
  ) {
    const p = event.payload;
    const item = ctx.state.workItemOrder.find(
      (key) => p.commandId === stageCommandId(ctx, stageId, 'issue', key),
    );
    return [
      internal({
        type: 'RecordStageArtifact',
        meta: metaFor(ctx),
        stageId,
        commandId: p.commandId,
        artifact: {
          artifactId: p.commandId,
          kind: 'issue',
          number: p.result.issue,
          url: p.result.url,
          purpose: item === undefined ? 'conclusion' : 'work-item',
          ...(item === undefined ? {} : { itemKey: item }),
        },
      }),
    ];
  }
  return [];
};

const relevant = new Set([
  'workflow.resumed',
  'gate.decided',
  'stage.started',
  'stage.completed',
  'command.succeeded',
  'command.failed',
  'seat.status',
  'seat.released',
  'seat.exited',
  'submission.accepted',
  'meeting.statement',
  'meeting.round_started',
  'meeting.round_completed',
  'meeting.concluded',
  'timer.fired',
]);

const reactMeeting: StageModule['react'] = (ctx) => {
  const workflow = ctx.state.workflow;
  const config = workflow?.template.stages.find((s) => s.kind === 'meeting');
  if (!workflow || config?.kind !== 'meeting' || !relevant.has(ctx.event.type))
    return [];
  const stageId = config.id;
  const wake =
    ctx.event.type === 'workflow.resumed' ||
    (ctx.event.type === 'gate.decided' &&
      ctx.state.gates[ctx.event.payload.gateId]?.stageId === stageId &&
      ['top-up', 'top-up-rerun'].includes(ctx.event.payload.optionId ?? ''));
  if (ctx.event.type === 'gate.decided' && !wake) return [];
  const stage = ctx.state.stages[stageId]!;
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
  const id = (...parts: (string | number)[]) =>
    stageCommandId(ctx, stageId, ...parts);
  const commands = ctx.state.commands;
  const session = sessionRef(ctx.state);
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
  if (!session) return effects;
  if (!commands[id('workspace')]) {
    const suffix = stage.attempt > 1 ? `-a${stage.attempt}` : '';
    return [
      ...effects,
      external(
        id('workspace'),
        {
          kind: 'runtime.prepareWorkspace',
          args: {
            session,
            repo: {
              orcaRepoId: workflow.repo.orcaRepoId,
              localPath: workflow.repo.localPath,
            },
            // §7.2: the local default branch may be stale; read the fetched remote head.
            baseBranch: `origin/${workflow.repo.defaultBranch}`,
            fetchBranch: workflow.repo.defaultBranch,
            name: `aio-${workflow.shortId}-meeting${suffix}`,
            branch: `ai-office/${workflow.shortId}/meeting${suffix}`,
          },
        },
        { stageId },
      ),
    ];
  }
  const workspaceResult = commands[id('workspace')]?.result;
  if (
    workspaceResult?.kind !== 'runtime.prepareWorkspace' ||
    workspaceResult.result === null ||
    !('workspace' in workspaceResult.result)
  )
    return effects;
  const workspace = workspaceResult.result.workspace;
  const attempts = stageAttempts(ctx.state, stageId);
  const lead = attempts.find((a) => a.purpose === 'facilitator');
  if (
    !lead &&
    !wake &&
    !(
      ctx.event.type === 'command.succeeded' &&
      ctx.event.payload.commandId === id('workspace')
    )
  )
    return effects;
  if (!lead)
    return spawnStageAgent(
      ctx,
      config.facilitator,
      { purpose: 'facilitator', stageId },
      { kind: 'existing-worktree', workspace, readOnly: true },
      true,
    );
  const meeting = ctx.state.meetings[stageId]!;
  const rounds = Object.values(meeting.rounds);
  const round = rounds.at(-1);
  const participants = attempts.filter(
    (a) =>
      a.purpose === 'participant' &&
      (!round || round.attemptIds.includes(a.attemptId)),
  );
  const agenda = submitted(ctx.state, lead, 'agenda');
  const conclusion = submitted(ctx.state, lead, 'conclusion');
  const stageTimer =
    ctx.timer?.payload.purpose === 'stage-timeout' &&
    ctx.timer.payload.stageId === stageId &&
    ctx.timer.payload.attempt === stage.attempt;
  if (stageTimer) {
    if (
      ctx.timer!.id.includes('/grace/agenda/') &&
      agenda &&
      participants.length
    )
      return [];
    if (ctx.timer!.id.includes('/grace/conclusion/') && meeting.concluded)
      return [];
    if (ctx.timer!.id.includes('/grace/'))
      return stageViolation(
        ctx,
        stageId,
        'Missing required meeting output or turn completion',
      );
    return remind(
      ctx,
      lead,
      'meeting completion',
      { purpose: 'stage-timeout', stageId, attempt: stage.attempt },
      5 * MINUTE_MS,
    );
  }
  if (!agenda)
    return lead.state === 'done'
      ? remind(
          ctx,
          lead,
          'agenda',
          { purpose: 'stage-timeout', stageId, attempt: stage.attempt },
          5 * MINUTE_MS,
        )
      : effects;
  if (
    !participants.length &&
    lead.state === 'done' &&
    (wake ||
      !(
        ctx.before.attempts[lead.attemptId]?.state === 'done' &&
        submitted(ctx.before, ctx.before.attempts[lead.attemptId], 'agenda')
      ))
  )
    return config.participants.flatMap((role) =>
      spawnStageAgent(
        ctx,
        role,
        { purpose: 'participant', stageId, role },
        { kind: 'existing-worktree', workspace, readOnly: true },
        true,
      ),
    );
  if (!participants.length) return effects;
  if (!round) {
    if (
      participants.length === config.participants.length &&
      participants.every((a) => a.state === 'done' && a.agentRef) &&
      !participants.every(
        (a) =>
          ctx.before.attempts[a.attemptId]?.state === 'done' &&
          ctx.before.attempts[a.attemptId]?.agentRef,
      )
    )
      return [
        internal({
          type: 'StartMeetingRound',
          meta: metaFor(ctx),
          stageId,
          round: 1,
          attemptIds: participants.map((a) => a.attemptId),
        }),
      ];
    return effects;
  }
  if (
    ctx.event.type === 'meeting.round_started' &&
    ctx.event.payload.stageId === stageId
  ) {
    const previous = rounds
      .filter((r) => r.round === round.round - 1)
      .flatMap((r) => r.attemptIds.map((a) => r.statements[a]?.artifactId))
      .filter(Boolean);
    const prior = Object.values(ctx.state.submissions)
      .filter((s) => previous.includes(s.artifactId ?? s.id))
      .map((s) => s.submission);
    return [
      schedule(
        ctx,
        { purpose: 'round-timeout', stageId, round: round.round },
        config.timeouts.roundMin * MINUTE_MS,
        stage.attempt,
      ),
      ...participants
        .filter((a) => !a.released && a.agentRef)
        .flatMap((a) => [
          internal({
            type: 'ObserveAttemptStatus',
            meta: metaFor(ctx),
            attemptId: a.attemptId,
            state: 'working',
          }),
          external(
            id('round', round.round, 'send', a.attemptId),
            {
              kind: 'runtime.send',
              args: {
                agent: a.agentRef!,
                subject: `Meeting round ${round.round}`,
                body: JSON.stringify({
                  round: round.round,
                  agenda: agenda.submission.payload,
                  previousStatements: prior,
                }),
              },
            },
            { stageId, attemptId: a.attemptId },
          ),
        ]),
    ];
  }
  if (
    ctx.event.type === 'submission.accepted' &&
    ctx.event.payload.kind === 'statement' &&
    participants.some((a) => a.attemptId === ctx.event.attemptId)
  ) {
    const s = ctx.event.payload.submission;
    if (
      s.kind === 'statement' &&
      s.payload.round === round.round &&
      !round.completed
    )
      return [
        internal({
          type: 'RecordMeetingStatement',
          meta: metaFor(ctx),
          stageId,
          submissionId: ctx.event.payload.submissionId,
        }),
      ];
  }
  if (!round.completed) {
    const ready = (a: Attempt) =>
      !!round.statements[a.attemptId] && a.state === 'done';
    const absent = participants.filter(
      (a) => a.released || a.state === 'exited',
    );
    if (participants.every((a) => ready(a) || absent.includes(a))) {
      const previous = ctx.before.meetings[stageId]?.rounds[round.round];
      if (
        participants.every((a) => {
          const prior = ctx.before.attempts[a.attemptId];
          return (
            prior &&
            (prior.released ||
              prior.state === 'exited' ||
              (prior.state === 'done' && previous?.statements[a.attemptId]))
          );
        })
      )
        return effects;
      return [
        ...Object.values(ctx.state.timers)
          .filter(
            (t) =>
              t.payload.purpose === 'round-timeout' &&
              t.payload.stageId === stageId &&
              t.payload.round === round.round,
          )
          .map((t) => cancelTimer(t.id, 'round_completed')),
        internal({
          type: 'CompleteMeetingRound',
          meta: metaFor(ctx),
          stageId,
          round: round.round,
          absentAttemptIds: absent.map((a) => a.attemptId),
        }),
      ];
    }
    const timeout =
      ctx.timer?.payload.purpose === 'round-timeout' &&
      ctx.timer.payload.stageId === stageId &&
      ctx.timer.payload.round === round.round;
    if (timeout && ctx.timer!.id.includes('/grace/')) {
      const a = participants.find((a) =>
        ctx.timer!.id.endsWith(`/round ${round.round}/${a.attemptId}`),
      );
      return a && !ready(a)
        ? [
            ...stopAttempt(ctx, a, 'absent', round.round),
            ...releaseAttempt(ctx, a, false, 'absent', round.round),
          ]
        : [];
    }
    return participants
      .filter(
        (a) =>
          !absent.includes(a) &&
          !ready(a) &&
          (timeout ||
            (a.state === 'done' &&
              ctx.event.type === 'seat.status' &&
              ctx.event.payload.attemptId === a.attemptId &&
              ctx.event.payload.state === 'done' &&
              (() => {
                const accepted = submitted(
                  ctx.state,
                  a,
                  'statement',
                )?.submission;
                return (
                  accepted?.kind !== 'statement' ||
                  accepted.payload.round !== round.round
                );
              })())),
      )
      .flatMap((a) =>
        remind(
          ctx,
          a,
          `round ${round.round}`,
          { purpose: 'round-timeout', stageId, round: round.round },
          5 * MINUTE_MS,
        ),
      );
  }
  if (round.completed.statements < 2)
    return ctx.event.type === 'meeting.round_completed'
      ? stageViolation(
          ctx,
          stageId,
          'Fewer than two effective meeting speakers',
        )
      : [];
  if (round.round < config.maxRounds && !round.completed.allReadyToConclude) {
    if (ctx.event.type !== 'meeting.round_completed') return [];
    return [
      internal({
        type: 'StartMeetingRound',
        meta: metaFor(ctx),
        stageId,
        round: round.round + 1,
        attemptIds: participants
          .filter((a) => !a.released && a.state !== 'exited')
          .map((a) => a.attemptId),
      }),
    ];
  }
  if (!commands[id('conclusion-send')] && lead.agentRef) {
    const statements = Object.values(ctx.state.submissions)
      .filter(
        (s) =>
          s.kind === 'statement' &&
          participants.some((a) => a.attemptId === s.attemptId),
      )
      .map((s) => s.submission);
    return [
      internal({
        type: 'ObserveAttemptStatus',
        meta: metaFor(ctx),
        attemptId: lead.attemptId,
        state: 'working',
      }),
      external(
        id('conclusion-send'),
        {
          kind: 'runtime.send',
          args: {
            agent: lead.agentRef,
            subject: 'Write meeting conclusion',
            body: JSON.stringify({
              agenda: agenda.submission.payload,
              statements,
            }),
          },
        },
        { stageId, attemptId: lead.attemptId },
      ),
    ];
  }
  if (!conclusion)
    return lead.state === 'done'
      ? remind(
          ctx,
          lead,
          'conclusion',
          { purpose: 'stage-timeout', stageId, attempt: stage.attempt },
          5 * MINUTE_MS,
        )
      : effects;
  if (lead.state !== 'done' && !meeting.concluded) return effects;
  if (!meeting.concluded)
    return [
      internal({
        type: 'ConcludeMeeting',
        meta: metaFor(ctx),
        stageId,
        submissionId: conclusion.id,
      }),
    ];
  if (!commands[id('inspect')])
    return [
      external(
        id('inspect'),
        { kind: 'runtime.inspectWorkspace', args: { workspace } },
        { stageId },
      ),
    ];
  const inspected = commands[id('inspect')]?.result;
  if (
    inspected?.kind !== 'runtime.inspectWorkspace' ||
    inspected.result === null ||
    !('clean' in inspected.result)
  )
    return effects;
  if (!inspected.result.clean)
    return ctx.event.type === 'command.succeeded' &&
      ctx.event.payload.commandId === id('inspect')
      ? stageViolation(
          ctx,
          stageId,
          'Meeting worktree was modified',
          inspected.result.changedFiles,
        )
      : [];
  // A permanently failed release must not hang the meeting: the stage completes
  // and the §8.1 pre-gate protocol stops it again or opens the anomaly gate.
  const releasing = attempts.filter(
    (a) =>
      !a.released &&
      commands[commandId(ctx, 'release', a.attemptId, 'meeting-end')]
        ?.status !== 'failed',
  );
  if (releasing.length)
    return releasing
      .filter(
        (a) => !commands[commandId(ctx, 'release', a.attemptId, 'meeting-end')],
      )
      .flatMap((a) => [
        ...stopAttempt(ctx, a, 'meeting-end'),
        ...releaseAttempt(ctx, a, false, 'meeting-end'),
      ]);
  if (!commands[id('dispose')])
    return [
      external(
        id('dispose'),
        { kind: 'runtime.disposeWorkspace', args: { workspace } },
        { stageId },
      ),
    ];
  if (commands[id('dispose')]?.status !== 'succeeded') return effects;
  if (!commands[id('issue')] && conclusion.submission.kind === 'conclusion') {
    const body = `${renderMeetingConclusion(conclusion.submission.payload)}\n\n<!-- ai-office:cmd=${id('issue')} -->`;
    return [
      external(
        id('issue'),
        {
          kind: 'scm.createIssue',
          args: {
            repo: workflow.repo.github,
            title: `${workflow.template.name}: 結論`,
            body,
            labels: [
              'ai-office:conclusion',
              workflow.gateToggles[config.gate.id] === false
                ? 'ai-office:auto-approved'
                : 'ai-office:pending',
            ],
          },
        },
        { stageId },
      ),
    ];
  }
  if (commands[id('issue')]?.status === 'succeeded')
    return [
      internal({
        type: 'CompleteStage',
        meta: metaFor(ctx),
        stageId,
        attempt: stage.attempt,
      }),
    ];
  return effects;
};
export const meetingStage: StageModule = {
  stageGate: gate,
  react: (ctx) => {
    const stage = ctx.state.workflow?.template.stages.find(
      (s) => s.kind === 'meeting',
    );
    return [
      ...(stage ? stageArtifact(ctx, stage.id) : []),
      ...reactMeeting(ctx),
    ];
  },
};
// SHA-256, FIPS 180-4: 32-bit words, big-endian blocks and a 64-bit bit length.
const constants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotate = (word: number, bits: number): number =>
  (word >>> bits) | (word << (32 - bits));

export function sha256(input: Uint8Array): string {
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setBigUint64(padded.length - 8, BigInt(input.length) * 8n);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15]!;
      const y = words[i - 2]!;
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      words[i] = words[i - 16]! + s0 + words[i - 7]! + s1;
    }
    let a = hash[0]!,
      b = hash[1]!,
      c = hash[2]!,
      d = hash[3]!;
    let e = hash[4]!,
      f = hash[5]!,
      g = hash[6]!,
      h = hash[7]!;
    for (let i = 0; i < 64; i++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + constants[i]! + words[i]!) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    for (const [i, word] of [a, b, c, d, e, f, g, h].entries())
      hash[i] = hash[i]! + word;
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, '0')).join(
    '',
  );
}

export const conclusionHash = (body: string): string =>
  sha256(
    Uint8Array.from(
      [...body].flatMap((char) => {
        let point = char.codePointAt(0)!;
        if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd;
        if (point < 0x80) return [point];
        if (point < 0x800) return [0xc0 | (point >> 6), 0x80 | (point & 63)];
        if (point < 0x10000)
          return [
            0xe0 | (point >> 12),
            0x80 | ((point >> 6) & 63),
            0x80 | (point & 63),
          ];
        return [
          0xf0 | (point >> 18),
          0x80 | ((point >> 12) & 63),
          0x80 | ((point >> 6) & 63),
          0x80 | (point & 63),
        ];
      }),
    ),
  );
