import { CURRENT_SCHEMA_VERSION } from '@ai-office/contracts/events';
import type {
  CommandResult,
  DomainEventDraft,
  EventPayload,
  EventType,
  ExternalCommand,
} from '@ai-office/contracts/events';
import { PortError } from '../../ports/errors.js';
import type { RuntimePort } from '../../ports/runtime.js';
import type { ScmPort } from '../../ports/scm.js';
import type { Clock } from '../../ports/services.js';
import type { SpecStore } from '../../ports/stores.js';
import type { WorkflowRunner } from '../runner/workflow-runner.js';
import type { WorkflowRunners } from '../runner/runners.js';

type Recovery =
  | { outcome: 'found'; result: CommandResult }
  | { outcome: 'redone' | 'pending' };
export interface ReconcilerDeps {
  runtime: RuntimePort;
  scm: ScmPort;
  specStore: SpecStore;
  clock: Clock;
}

/** Startup-only reconciliation. Call again for pending receipts; never dispatch them twice. */
export class Reconciler {
  private running: Promise<{ pending: number }> | undefined;
  constructor(private readonly deps: ReconcilerDeps) {}

  reconcile(runners: WorkflowRunners): Promise<{ pending: number }> {
    if (this.running) return this.running;
    this.running = this.run(runners).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(runners: WorkflowRunners): Promise<{ pending: number }> {
    let pending = 0;
    for (const runner of runners.all()) {
      // New reactions may have issued commands during restore; let those settle first.
      await runner.idle();
      for (const record of Object.values(runner.state.commands)) {
        if (record.status === 'failed' && record.reconciled === 'redone') {
          await this.giveUp(
            runner,
            record.id,
            record.issued.kind,
            runner.issuedCommand(record.id)?.stageId,
            'redo_failed',
          );
          continue;
        }
        if (runner.state.commands[record.id]?.status !== 'issued') continue;
        const { commandId, orcaRequestId, ...command } = record.issued;
        const concrete = command as ExternalCommand;
        const stageId = runner.issuedCommand(commandId)?.stageId;
        let recovery: Recovery;
        try {
          recovery = await this.lookup(commandId, orcaRequestId, concrete);
        } catch (error) {
          // Connectivity does not establish absence or justify a duplicate mutation.
          if (
            error instanceof PortError &&
            ['transient', 'rate_limited', 'identity'].includes(error.category)
          ) {
            pending++;
            continue;
          }
          await this.giveUp(
            runner,
            commandId,
            concrete.kind,
            stageId,
            error instanceof PortError ? error.code : 'reconcile_failed',
          );
          continue;
        }
        if (recovery.outcome === 'pending') {
          pending++;
          continue;
        }
        const reconciled = this.draft(runner, 'command.reconciled', {
          commandId,
          kind: concrete.kind,
          outcome: recovery.outcome,
        });
        if (recovery.outcome === 'found') {
          // Both facts commit together; react sees the real result and can continue the workflow.
          const success = this.draft(runner, 'command.succeeded', {
            commandId,
            ...recovery.result,
          } as EventPayload<'command.succeeded'>);
          if (stageId !== undefined) success.stageId = stageId;
          if (record.attemptId !== undefined)
            success.attemptId = record.attemptId;
          await runner.append([reconciled, success]);
        } else {
          await runner.append([reconciled]);
          runner.redo(commandId);
          await runner.idle();
          // A result write can fail after the external mutation succeeded.
          // Keep startup blocked so the next pass can recover that result.
          if (runner.state.commands[commandId]?.status === 'issued') pending++;
          if (runner.state.commands[commandId]?.status === 'failed')
            await this.giveUp(
              runner,
              commandId,
              concrete.kind,
              stageId,
              'redo_failed',
            );
        }
      }
    }
    return { pending };
  }

  private async lookup(
    commandId: string,
    requestId: string | undefined,
    command: ExternalCommand,
  ): Promise<Recovery> {
    const found = (result: CommandResult): Recovery => {
      if (result.kind !== command.kind)
        throw new PortError(
          'bug',
          'reconcile_kind_mismatch',
          'Recovered command kind differs',
        );
      return { outcome: 'found', result };
    };
    switch (command.kind) {
      case 'runtime.spawnAgent':
        if (
          this.deps.specStore.read(
            command.args.specPath,
            command.args.specSha256,
          ) === null
        )
          throw new PortError(
            'bug',
            'spec_mismatch',
            'Persisted spec is missing or changed',
          );
      // fall through: all orchestration mutations share the receipt/marker policy.
      case 'runtime.openSession':
      case 'runtime.send':
      case 'runtime.answer': {
        if (requestId === undefined)
          throw new PortError(
            'bug',
            'missing_request_id',
            'Missing recorded request ID',
          );
        const receipt = await this.deps.runtime.inspectRequest(
          requestId,
          commandId,
        );
        if (receipt.status === 'pending') return { outcome: 'pending' };
        if (receipt.status === 'completed') return found(receipt.result);
        const marker = await this.deps.runtime.findCommandByMarker(commandId);
        return marker ? found(marker) : { outcome: 'redone' };
      }
      case 'runtime.prepareWorkspace': {
        const result = await this.deps.runtime.findWorkspace({
          repo: command.args.repo,
          name: command.args.name,
          commandId,
        });
        if (
          result &&
          command.args.fetchBranch !== undefined &&
          result.baseSha !== command.args.baseBranch
        )
          throw new PortError(
            'guard',
            'workspace_base_mismatch',
            'Recovered workspace has a different base',
          );
        return result
          ? found({ kind: command.kind, result })
          : { outcome: 'redone' };
      }
      case 'scm.createIssue':
      case 'scm.openPR':
      case 'scm.comment': {
        const repo =
          command.kind === 'scm.comment'
            ? command.args.target.repo
            : command.args.repo;
        const ref = await this.deps.scm.findByMarker(repo, commandId);
        if (!ref) return { outcome: 'redone' };
        if (command.kind === 'scm.comment') {
          if (ref.number !== command.args.target.number)
            throw new PortError(
              'guard',
              'marker_target_mismatch',
              'Comment marker belongs to another target',
            );
          return found({ kind: command.kind, result: {} });
        }
        const url = `https://github.com/${repo.owner}/${repo.name}/${command.kind === 'scm.openPR' ? 'pull' : 'issues'}/${ref.number}`;
        return command.kind === 'scm.openPR'
          ? found({ kind: command.kind, result: { pr: ref.number, url } })
          : found({ kind: command.kind, result: { issue: ref.number, url } });
      }
      case 'scm.mergePR': {
        const pr = await this.deps.scm.getPR(command.args.pr);
        if (pr.state !== 'merged') return { outcome: 'redone' };
        if (!pr.mergeCommitSha)
          throw new PortError(
            'bug',
            'missing_merge_sha',
            'Merged PR has no commit SHA',
          );
        return found({
          kind: command.kind,
          result: { mergeCommitSha: pr.mergeCommitSha },
        });
      }
      // Read-only calls and explicitly idempotent mutations.
      case 'runtime.disposeWorkspace':
      case 'runtime.inspectWorkspace':
      case 'scm.compareBranch':
      case 'runtime.stop':
      case 'runtime.release':
      case 'runtime.reclaimSession':
      case 'scm.ensureLabels':
      case 'scm.ensureBranch':
      case 'scm.deleteBranch':
      case 'scm.updateIssue':
      case 'scm.updatePR':
      case 'scm.setLabels':
        return { outcome: 'redone' };
      default: {
        const exhaustive: never = command;
        throw new Error(`Unsupported command: ${String(exhaustive)}`);
      }
    }
  }

  private async giveUp(
    runner: WorkflowRunner,
    commandId: string,
    kind: ExternalCommand['kind'],
    stageId: string | undefined,
    detail: string,
  ): Promise<void> {
    const gateId = `reconcile:${commandId}`;
    const drafts: DomainEventDraft[] = [
      this.draft(runner, 'command.reconciled', {
        commandId,
        kind,
        outcome: 'gave_up',
        detail,
      }),
    ];
    if (runner.state.commands[commandId]?.status === 'issued')
      drafts.push(
        this.draft(runner, 'command.failed', {
          commandId,
          kind,
          attempts: 1,
          error: {
            category: 'bug',
            code: detail,
            message: 'Command recovery requires intervention',
            retryable: false,
          },
        }),
      );
    // Atomic failure + anomaly gate: another crash cannot strand a terminal command without its gate.
    if (!runner.state.gates[gateId])
      drafts.push(
        this.draft(runner, 'gate.opened', {
          gateId,
          stageId:
            stageId ??
            Object.values(runner.state.stages).find(
              (s) => s.status === 'running',
            )?.id ??
            'recovery',
          kind: 'exception',
          exceptionKind: 'anomaly',
          title: 'Command recovery needs attention',
          version: 1,
          options: [
            { optionId: 'continue', label: 'Continue' },
            { optionId: 'stop-again', label: 'Stop again' },
            { optionId: 'abort', label: 'Abort workflow' },
          ],
          content: { type: 'exception', summary: detail, commandId },
        }),
      );
    if (!runner.state.workflow?.pausedReasons.includes('anomaly'))
      drafts.push(this.draft(runner, 'workflow.paused', { reason: 'anomaly' }));
    await runner.append(drafts);
  }

  private draft<T extends EventType>(
    runner: WorkflowRunner,
    type: T,
    payload: EventPayload<T>,
  ): DomainEventDraft {
    return {
      type,
      payload,
      workflowId: runner.workflowId,
      occurredAt: this.deps.clock.now().toISOString(),
      source: 'system',
      provenance: 'observed',
      schemaVersion: CURRENT_SCHEMA_VERSION[type],
    } as DomainEventDraft;
  }
}
