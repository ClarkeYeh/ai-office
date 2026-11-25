import type { Attempt } from '@ai-office/domain';
import type { RuntimeEvent } from '../../ports/runtime-events.js';
import type { RedactorFactory } from '../../ports/services.js';
import { Batch } from './batch.js';

export function attemptBranch(batch: Batch, attempt: Attempt): string | null {
  const spawn = batch.state.commands[attempt.spawnCommandId]?.issued;
  if (
    spawn?.kind === 'runtime.spawnAgent' &&
    spawn.args.workspace.kind === 'new-worktree'
  )
    return spawn.args.workspace.branch;
  // A rework attempt may use an existing worktree. Resolve that exact workspace,
  // not the current work item's branch (which could belong to a later attempt).
  if (
    spawn?.kind === 'runtime.spawnAgent' &&
    spawn.args.workspace.kind === 'existing-worktree'
  ) {
    const workspace = spawn.args.workspace.workspace;
    for (const record of Object.values(batch.state.commands))
      if (
        record.issued.kind === 'runtime.prepareWorkspace' &&
        record.result?.kind === 'runtime.prepareWorkspace' &&
        record.result.result !== null &&
        'workspace' in record.result.result &&
        record.result.result.workspace === workspace
      )
        return record.issued.args.branch;
  }
  return null;
}

export function ingestRuntime(
  batch: Batch,
  events: readonly RuntimeEvent[],
  factory: RedactorFactory,
): void {
  const workflow = batch.state.workflow!;
  for (const event of events) {
    if (batch.observed(event.externalKey)) continue;
    if (event.type === 'agent.unmanaged') {
      const redactor = factory.forAttempt({
        attemptId: 'unmanaged',
        currentBranch: null,
        defaultBranch: workflow.repo.defaultBranch,
        integrationBranch: workflow.integrationBranch,
      });
      batch.anomaly(
        {
          kind: 'unmanaged-agent',
          agent: redactor.maskSecrets({
            dispatch: event.dispatch,
            ...(event.parentDispatch === undefined
              ? {}
              : { parentDispatch: event.parentDispatch }),
            ...(event.agentKind === undefined
              ? {}
              : { agentKind: event.agentKind }),
            ...(event.title === undefined ? {} : { title: event.title }),
          }),
        },
        event,
        'runtime',
      );
      continue;
    }
    if (event.type === 'runtime.identity_restored') {
      batch.add(
        event.type,
        { newShim: event.newShim, runs: event.runs },
        event,
        'runtime',
      );
      continue;
    }
    if (event.type === 'runtime.identity_hijacked') {
      batch.add(
        event.type,
        {
          run: event.run,
          coordinatorHandle: event.coordinatorHandle,
          consumerGeneration: event.consumerGeneration,
        },
        event,
        'runtime',
      );
      batch.add('workflow.paused', { reason: 'hijacked' }, event, 'runtime');
      continue;
    }
    if (event.type === 'runtime.contract_mismatch') {
      // Raw adapter validation issues may contain input values; never persist them.
      batch.add(
        'workflow.paused',
        { reason: 'runtime_unhealthy' },
        event,
        'runtime',
      );
      continue;
    }
    const attempt = Object.values(batch.state.attempts).find(
      (a) => a.agentRef === event.agent,
    );
    if (!attempt)
      throw new Error('Runtime observation has no recorded attempt');
    const redactor = factory.forAttempt({
      attemptId: attempt.attemptId,
      currentBranch: attemptBranch(batch, attempt),
      defaultBranch: workflow.repo.defaultBranch,
      integrationBranch: workflow.integrationBranch,
    });
    const attemptId = attempt.attemptId;
    switch (event.type) {
      case 'agent.status':
        // M2-T17 D5: real Orca reports a finished keep-open worker `idle`
        // right after worker_done. Idle never downgrades done; only a new turn
        // (working / waiting_input) or exit/lost does, so the engine's `done`
        // checks (meeting rounds, conclusion, planning, items) stay true.
        // T12: and only a turn the backend gave (a send or answer issued after
        // the done, §7.1): Orca can still show the finished turn's `working`
        // stage after worker_done (pm: done → working → idle).
        if (
          attempt.state === 'done' &&
          (event.state === 'idle' ||
            ((event.state === 'working' || event.state === 'waiting_input') &&
              attempt.doneTurn === (attempt.turns ?? 0)))
        )
          break;
        batch.add(
          'seat.status',
          {
            attemptId,
            state: event.state,
            ...(event.waitingSince === undefined
              ? {}
              : { waitingSince: event.waitingSince }),
          },
          event,
          'runtime',
          attempt,
        );
        break;
      case 'agent.output': {
        const { activity, policyHits } = redactor.toActivity(event);
        // FX-ACTIVITY-DUP (T12): one transcript message is one fact per
        // attempt. Orca keys output by dispatch, and a keep-open seat gets a
        // new dispatch per turn on the same transcript, so earlier messages
        // came back under new keys; key them like turns, by message id.
        const message = {
          ...event,
          externalKey: `tx:${attemptId}:${event.messageId}`,
        };
        if (activity.length)
          batch.add(
            'seat.activity',
            { attemptId, activity },
            message,
            'runtime',
            attempt,
          );
        if (policyHits.length)
          batch.anomaly(
            { kind: 'policy-hits', attemptId, hits: policyHits },
            message,
            'runtime',
          );
        if (event.role === 'assistant')
          // Through decide, so maxTurns alerts fire (§10.2).
          batch.record(
            {
              type: 'RecordUsageTurns',
              meta: {
                occurredAt: event.occurredAt,
                source: 'runtime',
                provenance: 'observed',
              },
              usage: { attemptId, turns: 1 },
            },
            { ...event, externalKey: `turn:${attemptId}:${event.messageId}` },
            'usage.turns',
          );
        break;
      }
      case 'agent.question':
        batch.add(
          'message.question',
          {
            attemptId,
            questionId: event.question,
            body: redactor.maskSecrets(event.body),
            ...(attempt.itemKey === undefined
              ? {}
              : { itemKey: attempt.itemKey }),
          },
          { ...event, externalKey: `question:${event.question}` },
          'runtime',
          attempt,
        );
        break;
      case 'agent.done':
        batch.add(
          'seat.status',
          { attemptId, state: event.outcome === 'success' ? 'done' : 'error' },
          event,
          'runtime',
          attempt,
        );
        break;
      case 'agent.rate_limited':
        // S26 (provisional): never a failure; engine pauses the attempt's
        // timers. Through decide, which ignores evidence for ended attempts.
        batch.record(
          {
            type: 'ObserveAttemptStatus',
            meta: {
              occurredAt: event.occurredAt,
              source: 'runtime',
              provenance: 'observed',
            },
            attemptId,
            state: attempt.state,
            ...(attempt.waitingSince === undefined
              ? {}
              : { waitingSince: attempt.waitingSince }),
            rateLimited: {
              since: attempt.rateLimited?.since ?? event.occurredAt,
              evidence: event.evidence,
              ...(event.resetsAt === undefined
                ? {}
                : { resetsAt: event.resetsAt }),
            },
          },
          event,
          'seat.status',
        );
        break;
      case 'agent.degraded':
        batch.add(
          'seat.degraded',
          { attemptId, reason: event.reason },
          event,
          'runtime',
          attempt,
        );
        break;
      case 'agent.stopped':
      case 'agent.exited': {
        // Stop then release reports two exits; the attempt exits once.
        if (attempt.state === 'exited') break;
        const commanded = Object.values(batch.state.commands).some(
          (record) =>
            (record.issued.kind === 'runtime.stop' ||
              record.issued.kind === 'runtime.release') &&
            record.issued.args.agent === event.agent &&
            record.status !== 'failed' &&
            Date.parse(record.issuedAt) <= Date.parse(event.occurredAt),
        );
        const expected =
          commanded ||
          (event.type === 'agent.exited' &&
            (attempt.released ||
              (!attempt.keepOpen && attempt.state === 'done')));
        batch.add(
          'seat.exited',
          {
            attemptId,
            expected,
            reason:
              event.type === 'agent.stopped'
                ? 'stopped'
                : redactor.maskSecrets(event.reason),
          },
          event,
          'runtime',
          attempt,
        );
        if (!expected) {
          // No external-stop anomaly kind exists in v1; use the observable exit
          // and pause. The exception policy handles seat.exited{expected:false}.
          batch.add('workflow.paused', { reason: 'anomaly' }, event, 'runtime');
        }
        break;
      }
    }
  }
}
