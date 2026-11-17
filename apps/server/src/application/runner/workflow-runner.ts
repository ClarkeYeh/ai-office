import {
  CURRENT_SCHEMA_VERSION,
  ORCA_REQUEST_ID_KINDS,
} from '@ai-office/contracts/events';
import type {
  DomainEvent,
  DomainEventDraft,
  EventPayload,
  EventType,
  ExternalCommand,
} from '@ai-office/contracts/events';
import {
  decide,
  evolveWithWarning,
  initialState,
  isAttemptPossiblyAlive,
  replay,
} from '@ai-office/domain';
import type {
  CommandMeta,
  DomainCommand,
  DomainError,
  ErrorInfo,
  WorkflowState,
} from '@ai-office/domain';
import { react as engineReact } from '@ai-office/engine';
import type { Effect } from '@ai-office/engine';
import type { Clock, IdGen, Logger, Scheduler } from '../../ports/services.js';
import type {
  CursorWrite,
  EventStore,
  SeatTokenStore,
  SpecStore,
} from '../../ports/stores.js';
import { PAUSE_ON_FAILURE, RECORD_ON_FAILURE } from '../commands/errors.js';
import type {
  CommandExecutor,
  CommandOutcome,
  IssuedCommand,
} from '../commands/executor.js';
import { materializeSpawn } from '../commands/materialize.js';
import type { SpawnEffect } from '@ai-office/engine';

/** Runner consumes the engine effect contract, including spawn intents. */
export type RunnerEffect = Effect;
export type RunnerReact = (
  state: WorkflowState,
  event: DomainEvent,
) => readonly RunnerEffect[];

export type DispatchResult =
  { ok: true; events: DomainEvent[] } | { ok: false; error: DomainError };

export interface WorkflowRunnerDeps {
  store: EventStore;
  executor: CommandExecutor;
  scheduler: Scheduler;
  clock: Clock;
  ids: IdGen;
  logger: Logger;
  seatTokens: SeatTokenStore;
  specStore: SpecStore;
  /** `<installDir>/apps/cli/dist/main.js` (Q8), passed to SpecBuilder. */
  cliPath: string;
  /** Defaults to `@ai-office/engine`'s `react`. */
  react?: RunnerReact;
}

type Settle<T> = {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type Input =
  | { kind: 'command'; command: DomainCommand; settle?: Settle<DispatchResult> }
  | {
      kind: 'append';
      drafts: DomainEventDraft[];
      cursors?: CursorWrite[];
      settle: Settle<DomainEvent[]>;
    }
  | { kind: 'spawn'; effect: SpawnEffect; cause: DomainEvent }
  | { kind: 'result'; issued: IssuedCommand; outcome: CommandOutcome }
  | { kind: 'timer'; timerId: string };

type Scope = { stageId?: string; attemptId?: string };

const ORCA_REQUEST_KINDS: ReadonlySet<string> = new Set(ORCA_REQUEST_ID_KINDS);

const scopeOf = (value: {
  stageId?: string | undefined;
  attemptId?: string | undefined;
}): Scope => ({
  ...(value.stageId === undefined ? {} : { stageId: value.stageId }),
  ...(value.attemptId === undefined ? {} : { attemptId: value.attemptId }),
});

/** The recorded `command.issued`, exactly as the executor must replay it. */
const issuedFrom = (
  event: Extract<DomainEvent, { type: 'command.issued' }>,
): IssuedCommand => {
  const { commandId, orcaRequestId, ...command } = event.payload;
  return {
    workflowId: event.workflowId ?? '',
    commandId,
    command: command as ExternalCommand,
    ...(orcaRequestId === undefined ? {} : { orcaRequestId }),
    ...scopeOf(event),
  };
};

/**
 * WorkflowRunner (§11.4): the per-workflow actor. Every input — user command,
 * submission, observation, command result, timer — goes through one FIFO
 * queue and is processed to completion before the next:
 *
 *   decide → EventStore.append (one transaction) → for each stored event:
 *   react(stateBefore, event), evolve → handle effects in order:
 *     internal / spawn → back of the queue (spawn is materialized after the
 *                        SpawnAttempt queued before it has been decided)
 *     timer            → timer.scheduled, then Scheduler
 *     cancelTimer      → timer.cancelled (if still pending), then Scheduler
 *     external         → command.issued{orcaRequestId, args}, then
 *                        CommandExecutor; its outcome returns as a new input
 *
 * Port calls never block the queue (plan M1-T23 risk note). Everything else
 * is synchronous, so inputs never interleave.
 */
export class WorkflowRunner {
  private current: WorkflowState;
  private readonly queue: Input[] = [];
  private draining = false;
  private inFlight = 0;
  private idleWaiters: (() => void)[] = [];
  /** Attempts whose seat token and spec file were already cleaned up. */
  private readonly cleaned = new Set<string>();
  private readonly reactFn: RunnerReact;
  private readonly log: Logger;

  constructor(
    readonly workflowId: string,
    private readonly deps: WorkflowRunnerDeps,
    state: WorkflowState = initialState(),
  ) {
    this.current = state;
    this.reactFn = deps.react ?? engineReact;
    this.log = deps.logger.child({ workflowId });
  }

  /**
   * Rebuilds a runner from its stored events (restart): state comes only from
   * events; pending `timer.scheduled` timers are handed to the Scheduler again
   * and cleanup missed before the crash is redone. Issued commands without a
   * result are the Reconciler's (T24), via `redo` / `deliver`.
   */
  static restore(
    workflowId: string,
    deps: WorkflowRunnerDeps,
    events: Iterable<DomainEvent>,
  ): WorkflowRunner {
    const { state, warnings } = replay(events);
    const runner = new WorkflowRunner(workflowId, deps, state);
    for (const warning of warnings)
      runner.log.warn({ warning }, 'event skipped during replay');
    runner.rearmTimers();
    for (const attemptId of Object.keys(state.attempts))
      runner.cleanupAttempt(attemptId);
    return runner;
  }

  get state(): WorkflowState {
    return this.current;
  }

  /** Runs a domain command through the queue; resolves with decide's outcome. */
  dispatch(command: DomainCommand): Promise<DispatchResult> {
    return new Promise((resolve, reject) =>
      this.enqueue({ kind: 'command', command, settle: { resolve, reject } }),
    );
  }

  /**
   * Appends already-derived events (e.g. observations with their ingest
   * cursors, §11.5) in the queue, so they get the same react treatment.
   */
  append(
    drafts: DomainEventDraft[],
    cursors?: CursorWrite[],
  ): Promise<DomainEvent[]> {
    return new Promise((resolve, reject) =>
      this.enqueue({
        kind: 'append',
        drafts,
        ...(cursors === undefined ? {} : { cursors }),
        settle: { resolve, reject },
      }),
    );
  }

  /** Scheduler delivery: writes `timer.fired` if the timer is still pending. */
  fireTimer(timerId: string): void {
    this.enqueue({ kind: 'timer', timerId });
  }

  /** Records a command outcome (also used by the Reconciler for `found`). */
  deliver(issued: IssuedCommand, outcome: CommandOutcome): void {
    this.enqueue({ kind: 'result', issued, outcome });
  }

  /**
   * Re-executes an issued command with its recorded args (reconcile `redone`).
   * Returns false when the command is unknown or already has a result.
   */
  redo(commandId: string): boolean {
    const record = this.current.commands[commandId];
    if (record?.status !== 'issued') return false;
    const { commandId: id, orcaRequestId, ...command } = record.issued;
    this.execute({
      workflowId: this.workflowId,
      commandId: id,
      command: command as ExternalCommand,
      ...(orcaRequestId === undefined ? {} : { orcaRequestId }),
      ...scopeOf(record),
    });
    return true;
  }

  /** Hands every pending timer to the Scheduler (after a restart). */
  rearmTimers(): void {
    for (const timer of Object.values(this.current.timers))
      this.deps.scheduler.schedule({
        id: timer.id,
        workflowId: this.workflowId,
        fireAt: timer.fireAt,
      });
  }

  /** Resolves once the queue is empty and no command is executing. */
  idle(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Queued inputs or commands still executing. */
  get busy(): boolean {
    return this.draining || this.queue.length > 0 || this.inFlight > 0;
  }

  private enqueue(input: Input): void {
    this.queue.push(input);
    this.drain();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let input = this.queue.shift(); input; input = this.queue.shift())
        this.process(input);
    } finally {
      this.draining = false;
    }
    if (!this.busy) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  private process(input: Input): void {
    try {
      switch (input.kind) {
        case 'command': {
          const result = this.runCommand(input.command);
          input.settle?.resolve(result);
          return;
        }
        case 'append':
          input.settle.resolve(this.commit(input.drafts, input.cursors));
          return;
        case 'spawn':
          this.spawn(input.effect, input.cause);
          return;
        case 'result':
          this.record(input.issued, input.outcome);
          return;
        case 'timer':
          if (Object.hasOwn(this.current.timers, input.timerId))
            this.commit([
              this.draft(
                'timer.fired',
                { timerId: input.timerId },
                {},
                { source: 'system', provenance: 'observed' },
              ),
            ]);
          return;
      }
    } catch (error) {
      // A failed append (store down) loses only this input; the queue goes on.
      this.log.error(
        { input: input.kind, error: String(error) },
        'input failed',
      );
      if ('settle' in input) input.settle?.reject(error);
    }
  }

  private runCommand(command: DomainCommand): DispatchResult {
    const result = decide(this.current, command);
    if (!result.ok) {
      this.log.info(
        { command: command.type, error: result.error },
        'command rejected',
      );
      return result;
    }
    return { ok: true, events: this.commit(result.events) };
  }

  /** One transaction, then react/evolve per stored event, then the effects. */
  private commit(
    drafts: DomainEventDraft[],
    cursors?: CursorWrite[],
  ): DomainEvent[] {
    const stored = this.deps.store.append(
      drafts,
      cursors === undefined ? undefined : { cursors },
    );
    const effects: [RunnerEffect, DomainEvent][] = [];
    for (const event of stored) {
      // §11.4 / engine contract: react sees the state BEFORE the event.
      for (const effect of this.reactFn(this.current, event))
        effects.push([effect, event]);
      const applied = evolveWithWarning(this.current, event);
      if (applied.warning !== undefined)
        this.log.warn({ warning: applied.warning }, 'event skipped by evolve');
      this.current = applied.state;
      if (event.attemptId !== undefined) this.cleanupAttempt(event.attemptId);
    }
    for (const [effect, cause] of effects) this.handle(effect, cause);
    return stored;
  }

  private handle(effect: RunnerEffect, cause: DomainEvent): void {
    switch (effect.kind) {
      case 'internal':
        this.queue.push({ kind: 'command', command: effect.command });
        return;
      case 'spawn':
        this.queue.push({ kind: 'spawn', effect, cause });
        return;
      case 'timer':
        this.commit([
          this.draft(
            'timer.scheduled',
            {
              timerId: effect.timer.id,
              fireAt: effect.timer.fireAt,
              payload: effect.timer.payload,
            },
            {},
            { causationId: cause.id },
          ),
        ]);
        this.deps.scheduler.schedule({
          id: effect.timer.id,
          workflowId: this.workflowId,
          fireAt: effect.timer.fireAt,
        });
        return;
      case 'cancelTimer':
        if (!Object.hasOwn(this.current.timers, effect.id)) return;
        this.commit([
          this.draft(
            'timer.cancelled',
            {
              timerId: effect.id,
              ...(effect.reason === undefined ? {} : { reason: effect.reason }),
            },
            {},
            { causationId: cause.id },
          ),
        ]);
        this.deps.scheduler.cancel(effect.id);
        return;
      case 'external':
        this.issue(effect.commandId, effect.command, scopeOf(effect), cause);
        return;
    }
  }

  private spawn(effect: SpawnEffect, cause: DomainEvent): void {
    if (Object.hasOwn(this.current.commands, effect.commandId)) return;
    const command = materializeSpawn(this.current, effect, this.deps);
    if ('category' in command) {
      this.log.error(
        { commandId: effect.commandId, error: command },
        'spawn not materialized',
      );
      this.raise(
        {
          category: command.category,
          code: command.code,
          message: command.message,
          retryable: false,
        },
        { commandId: effect.commandId, stageId: effect.stageId },
        cause,
        // No attempt means decide refused the spawn; nothing ran, so do not pause.
        command.code !== 'spawn_without_attempt',
      );
      return;
    }
    this.issue(effect.commandId, command, scopeOf(effect), cause);
  }

  /** Writes `command.issued` (fully concrete, §11.5), then executes it. */
  private issue(
    commandId: string,
    command: ExternalCommand,
    scope: Scope,
    cause: DomainEvent,
  ): void {
    // Deterministic ids make a re-derived effect detectable: issue once.
    if (Object.hasOwn(this.current.commands, commandId)) return;
    const orcaRequestId = ORCA_REQUEST_KINDS.has(command.kind)
      ? this.deps.ids.orcaRequestId(commandId)
      : undefined;
    const [event] = this.commit([
      this.draft(
        'command.issued',
        {
          commandId,
          ...(orcaRequestId === undefined ? {} : { orcaRequestId }),
          ...command,
        } as EventPayload<'command.issued'>,
        scope,
        { causationId: cause.id },
      ),
    ]);
    if (event?.type === 'command.issued') this.execute(issuedFrom(event));
  }

  private execute(issued: IssuedCommand): void {
    this.inFlight++;
    const finish = (outcome: CommandOutcome) => {
      this.inFlight--;
      this.deliver(issued, outcome);
    };
    this.deps.executor.execute(issued).then(finish, (error: unknown) =>
      finish({
        ok: false,
        attempts: 1,
        error: {
          category: 'bug',
          code: 'executor_failed',
          message: String(error),
          retryable: false,
        },
      }),
    );
  }

  private record(issued: IssuedCommand, outcome: CommandOutcome): void {
    const source = issued.command.kind.startsWith('scm.') ? 'scm' : 'runtime';
    const scope = scopeOf(issued);
    const [event] = this.commit([
      outcome.ok
        ? this.draft(
            'command.succeeded',
            {
              commandId: issued.commandId,
              ...outcome.result,
            } as EventPayload<'command.succeeded'>,
            scope,
            { source, provenance: 'observed' },
          )
        : this.draft(
            'command.failed',
            {
              commandId: issued.commandId,
              kind: issued.command.kind,
              error: outcome.error,
              attempts: outcome.attempts,
            },
            scope,
            { source, provenance: 'observed' },
          ),
    ]);
    if (!outcome.ok && event !== undefined)
      this.raise(
        outcome.error,
        {
          commandId: issued.commandId,
          ...(issued.stageId === undefined ? {} : { stageId: issued.stageId }),
        },
        event,
        true,
      );
  }

  /** §15 follow-ups: `error.recorded` for bug/guard, pause for the listed categories. */
  private raise(
    error: ErrorInfo,
    target: { commandId: string; stageId?: string },
    cause: DomainEvent,
    pause: boolean,
  ): void {
    const meta: CommandMeta = {
      occurredAt: this.now(),
      source: 'engine',
      causationId: cause.id,
    };
    if (RECORD_ON_FAILURE.has(error.category))
      this.queue.push({
        kind: 'command',
        command: {
          type: 'RecordError',
          meta,
          category: error.category,
          code: error.code,
          message: error.message,
          ...target,
        },
      });
    const reason = pause ? PAUSE_ON_FAILURE[error.category] : undefined;
    if (
      reason !== undefined &&
      !this.current.workflow?.pausedReasons.includes(reason)
    )
      this.queue.push({
        kind: 'command',
        command: {
          type: 'PauseWorkflow',
          meta,
          reason,
          detail: `${target.commandId}: ${error.code}`,
        },
      });
  }

  /**
   * §16.1: once an attempt has ended (exited or released; a `lost` attempt may
   * still run) and its spawn command has a result, revoke its seat token and
   * delete its spec file. Both operations are idempotent.
   */
  private cleanupAttempt(attemptId: string): void {
    if (this.cleaned.has(attemptId)) return;
    const attempt = this.current.attempts[attemptId];
    if (attempt === undefined || isAttemptPossiblyAlive(attempt)) return;
    const spawn = this.current.commands[attempt.spawnCommandId];
    if (spawn?.status === 'issued') return;
    this.cleaned.add(attemptId);
    this.deps.seatTokens.revoke(attemptId);
    if (spawn?.issued.kind === 'runtime.spawnAgent')
      this.deps.specStore.remove(spawn.issued.args.specPath);
  }

  private now(): string {
    return this.deps.clock.now().toISOString();
  }

  private draft<T extends EventType>(
    type: T,
    payload: EventPayload<T>,
    scope: Scope,
    options: {
      source?: DomainEvent['source'];
      provenance?: DomainEvent['provenance'];
      causationId?: string;
    } = {},
  ): DomainEventDraft {
    return {
      type,
      payload,
      occurredAt: this.now(),
      workflowId: this.workflowId,
      ...scope,
      source: options.source ?? 'engine',
      provenance: options.provenance ?? 'decided',
      schemaVersion: CURRENT_SCHEMA_VERSION[type],
      ...(options.causationId === undefined
        ? {}
        : { causationId: options.causationId }),
    } as DomainEventDraft;
  }
}
