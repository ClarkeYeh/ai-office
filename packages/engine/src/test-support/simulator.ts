import {
  CURRENT_SCHEMA_VERSION,
  DomainEventSchema,
} from '@ai-office/contracts/events';
import type {
  CommandResult,
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
  possiblyLiveAttempts,
} from '@ai-office/domain';
import type {
  CommandMeta,
  DomainCommand,
  DomainError,
  ErrorInfo,
  EvolveWarning,
  WorkflowState,
} from '@ai-office/domain';
import type { SpawnEffect, ExternalEffect } from '../effects.js';
import { react as defaultReact } from '../react.js';
import type { React } from '../react.js';

/**
 * Pure workflow simulator (plan M1-T12): runs `decide → evolve → react` like
 * WorkflowRunner (§11.4) against a scripted outside world, on a virtual clock.
 * Inputs are processed FIFO; internal effects go to the back of the queue;
 * timer / cancelTimer / external effects are written immediately, in order,
 * as the runner does. Every event is checked against `DomainEventSchema`.
 */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** A domain command the world reports back; the simulator stamps `meta`. */
export type Observation = DistributiveOmit<DomainCommand, 'meta'>;

export type IssuedCommand = Omit<ExternalEffect, 'kind'>;

export type WorldReply =
  | { ok: true; result: CommandResult['result']; observe?: Observation[] }
  | { ok: false; error: ErrorInfo; observe?: Observation[] };

/** Returns `undefined` to leave the command unanswered (hung / ignored). */
export type World = (
  issued: IssuedCommand,
  sim: Simulator,
) => WorldReply | undefined;

type Input =
  | { kind: 'spawn'; effect: SpawnEffect }
  | { kind: 'command'; command: DomainCommand }
  | { kind: 'reply'; issued: IssuedCommand; reply: WorldReply };

export interface SimulatorOptions {
  world?: World;
  react?: React;
  /** Virtual clock start (ISO); defaults to 2026-11-17T00:00:00Z. */
  start?: string;
  /** Guard against effect loops. */
  maxSteps?: number;
}

const ok = (result: CommandResult['result'] = {}): WorldReply => ({
  ok: true,
  result,
});

/**
 * Default world: answers every command successfully with deterministic refs;
 * `runtime.stop` also reports the agent as exited.
 */
export const cooperativeWorld: World = (issued) => {
  const { command } = issued;
  switch (command.kind) {
    case 'runtime.openSession':
      return ok({ session: 'session-1' });
    case 'runtime.prepareWorkspace':
      return ok({
        workspace: `ws:${command.args.name}`,
        path: `/worktrees/${command.args.name}`,
      });
    case 'runtime.inspectWorkspace':
      return ok({ clean: true, changedFiles: [] });
    case 'runtime.spawnAgent':
      return ok({ agent: `agent:${issued.attemptId ?? issued.commandId}` });
    case 'runtime.stop':
      return issued.attemptId === undefined
        ? ok()
        : {
            ok: true,
            result: {},
            observe: [
              {
                type: 'RecordAttemptExited',
                attemptId: issued.attemptId,
                reason: 'stopped',
                expected: true,
              },
            ],
          };
    case 'scm.createIssue':
      return ok({ issue: 1, url: 'https://github.com/octo/demo/issues/1' });
    case 'scm.openPR':
      return ok({ pr: 2, url: 'https://github.com/octo/demo/pull/2' });
    case 'scm.mergePR':
      return ok({ mergeCommitSha: 'abcdef1' });
    default:
      return ok();
  }
};

const sourceFor = (command: ExternalCommand): 'runtime' | 'scm' =>
  command.kind.startsWith('scm.') ? 'scm' : 'runtime';

const ORCA_REQUEST_KINDS: ReadonlySet<string> = new Set([
  'runtime.openSession',
  'runtime.spawnAgent',
  'runtime.send',
  'runtime.answer',
]);

export class Simulator {
  state: WorkflowState = initialState();
  readonly events: DomainEvent[] = [];
  readonly warnings: EvolveWarning[] = [];
  /** Every command decide rejected, internal or not. */
  readonly rejections: { command: DomainCommand; error: DomainError }[] = [];
  /** Every internal effect engine produced, whether decide accepted it or not. */
  readonly internal: DomainCommand[] = [];
  /** Every external effect, in issue order. */
  readonly issued: IssuedCommand[] = [];
  now: number;

  private readonly queue: Input[] = [];
  private readonly world: World;
  private readonly reactFn: React;
  private readonly maxSteps: number;
  private steps = 0;

  constructor(options: SimulatorOptions = {}) {
    this.world = options.world ?? cooperativeWorld;
    this.reactFn = options.react ?? defaultReact;
    this.maxSteps = options.maxSteps ?? 10_000;
    this.now = Date.parse(options.start ?? '2026-11-17T00:00:00.000Z');
  }

  get clock(): string {
    return new Date(this.now).toISOString();
  }

  meta(source: CommandMeta['source'] = 'user'): CommandMeta {
    return { occurredAt: this.clock, source };
  }

  /** Enqueues a command (meta stamped now unless given) and drains the queue. */
  dispatch(
    command: Observation | DomainCommand,
    source?: CommandMeta['source'],
  ): this {
    const full = (
      'meta' in command ? command : { ...command, meta: this.meta(source) }
    ) as DomainCommand;
    this.queue.push({ kind: 'command', command: full });
    return this.drain();
  }

  /** Appends a hand-written event (e.g. one a later work item will decide) and drains. */
  inject<T extends EventType>(
    type: T,
    payload: EventPayload<T>,
    scope: Pick<DomainEventDraft, 'stageId' | 'attemptId' | 'seatId'> = {},
  ): this {
    this.append(this.draft(type, payload, scope));
    return this.drain();
  }

  /** Moves the clock forward, firing due timers in `fireAt` order. */
  advance(ms: number): this {
    const target = this.now + ms;
    for (;;) {
      const due = Object.values(this.state.timers)
        .filter((timer) => Date.parse(timer.fireAt) <= target)
        .sort(
          (a, b) =>
            Date.parse(a.fireAt) - Date.parse(b.fireAt) ||
            (a.id < b.id ? -1 : 1),
        )[0];
      if (due === undefined) break;
      this.now = Math.max(this.now, Date.parse(due.fireAt));
      this.append(this.draft('timer.fired', { timerId: due.id }));
      this.drain();
    }
    this.now = target;
    return this;
  }

  /** Agents not proven stopped (lost counts), as the §8.1 invariant requires. */
  liveAgents(): number {
    return possiblyLiveAttempts(this.state).length;
  }

  eventsOf<T extends EventType>(type: T): Extract<DomainEvent, { type: T }>[] {
    return this.events.filter(
      (event): event is Extract<DomainEvent, { type: T }> =>
        event.type === type,
    );
  }

  /** One line per event, for golden sequences. */
  trace(): string[] {
    return this.events.map(traceLine);
  }

  private drain(): this {
    for (let input = this.queue.shift(); input; input = this.queue.shift()) {
      if (++this.steps > this.maxSteps)
        throw new Error(`Simulator exceeded ${this.maxSteps} steps`);
      if (input.kind === 'spawn') this.spawn(input.effect);
      else if (input.kind === 'command') this.run(input.command);
      else this.receive(input.issued, input.reply);
    }
    return this;
  }

  private run(command: DomainCommand): void {
    const result = decide(this.state, command);
    if (!result.ok) {
      this.rejections.push({ command, error: result.error });
      return;
    }
    for (const draft of result.events) this.append(draft);
  }

  private receive(issued: IssuedCommand, reply: WorldReply): void {
    const source = sourceFor(issued.command);
    const scope = {
      ...(issued.stageId === undefined ? {} : { stageId: issued.stageId }),
      ...(issued.attemptId === undefined
        ? {}
        : { attemptId: issued.attemptId }),
    };
    this.append(
      reply.ok
        ? this.draft(
            'command.succeeded',
            {
              commandId: issued.commandId,
              kind: issued.command.kind,
              result: reply.result,
            } as EventPayload<'command.succeeded'>,
            scope,
            source,
          )
        : this.draft(
            'command.failed',
            {
              commandId: issued.commandId,
              kind: issued.command.kind,
              error: reply.error,
              attempts: 1,
            },
            scope,
            source,
          ),
    );
    for (const observation of reply.observe ?? [])
      this.queue.push({
        kind: 'command',
        command: { ...observation, meta: this.meta(source) } as DomainCommand,
      });
  }

  private draft<T extends EventType>(
    type: T,
    payload: EventPayload<T>,
    scope: Pick<DomainEventDraft, 'stageId' | 'attemptId' | 'seatId'> = {},
    source: DomainEvent['source'] = 'engine',
  ): DomainEventDraft {
    return {
      type,
      payload,
      occurredAt: this.clock,
      workflowId: this.state.workflowId,
      ...scope,
      source,
      provenance: source === 'engine' ? 'decided' : 'observed',
      schemaVersion: CURRENT_SCHEMA_VERSION[type],
    } as DomainEventDraft;
  }

  private append(draft: DomainEventDraft): void {
    const seq = this.events.length + 1;
    const event = DomainEventSchema.parse({
      ...draft,
      seq,
      id: `01${String(seq).padStart(24, '0')}`,
      recordedAt: draft.occurredAt,
    });
    const effects = this.reactFn(this.state, event);
    const applied = evolveWithWarning(this.state, event);
    this.state = applied.state;
    if (applied.warning !== undefined) this.warnings.push(applied.warning);
    this.events.push(event);
    for (const effect of effects) {
      switch (effect.kind) {
        case 'spawn':
          this.queue.push({ kind: 'spawn', effect });
          break;
        case 'internal':
          this.internal.push(effect.command);
          this.queue.push({ kind: 'command', command: effect.command });
          break;
        case 'timer':
          this.append(
            this.draft('timer.scheduled', {
              timerId: effect.timer.id,
              fireAt: effect.timer.fireAt,
              payload: effect.timer.payload,
            }),
          );
          break;
        case 'cancelTimer':
          if (Object.hasOwn(this.state.timers, effect.id))
            this.append(
              this.draft('timer.cancelled', {
                timerId: effect.id,
                ...(effect.reason === undefined
                  ? {}
                  : { reason: effect.reason }),
              }),
            );
          break;
        case 'external':
          this.issue(effect);
          break;
      }
    }
  }

  private spawn(effect: SpawnEffect): void {
    if (!this.state.attempts[effect.attemptId])
      throw new Error('Spawn intent has no attempt');
    this.issue({
      kind: 'external',
      commandId: effect.commandId,
      stageId: effect.stageId,
      attemptId: effect.attemptId,
      command: {
        kind: 'runtime.spawnAgent',
        args: {
          session: 'session-1',
          agent: effect.agent,
          title: effect.title ?? `aio:${effect.commandId}`,
          specPath: `/specs/${effect.attemptId}.md`,
          specSha256: 'a'.repeat(64),
          workspace: effect.workspace,
          keepOpen: effect.keepOpen,
        },
      },
    });
  }

  private issue(effect: ExternalEffect): void {
    const issued: IssuedCommand = {
      commandId: effect.commandId,
      command: effect.command,
      ...(effect.stageId === undefined ? {} : { stageId: effect.stageId }),
      ...(effect.attemptId === undefined
        ? {}
        : { attemptId: effect.attemptId }),
    };
    this.issued.push(issued);
    const orcaRequestId = ORCA_REQUEST_KINDS.has(effect.command.kind)
      ? `00000000-0000-4000-8000-${this.issued.length.toString(16).padStart(12, '0')}`
      : undefined;
    this.append(
      this.draft(
        'command.issued',
        {
          commandId: effect.commandId,
          ...(orcaRequestId === undefined ? {} : { orcaRequestId }),
          ...effect.command,
        } as EventPayload<'command.issued'>,
        {
          ...(effect.stageId === undefined ? {} : { stageId: effect.stageId }),
          ...(effect.attemptId === undefined
            ? {}
            : { attemptId: effect.attemptId }),
        },
      ),
    );
    const reply = this.world(issued, this);
    if (reply !== undefined) this.queue.push({ kind: 'reply', issued, reply });
  }
}

const traceLine = (event: DomainEvent): string => {
  const p = event.payload as Record<string, unknown>;
  const detail = (() => {
    switch (event.type) {
      case 'command.issued':
      case 'command.succeeded':
      case 'command.failed':
        return `${String(p.kind)} ${String(p.commandId)}`;
      case 'timer.scheduled':
      case 'timer.fired':
      case 'timer.cancelled':
        return String(p.timerId);
      case 'stage.started':
      case 'stage.completed':
      case 'stage.failed':
        return `${String(p.stageId)}#${String(p.attempt)}`;
      case 'gate.opened':
      case 'gate.decided':
      case 'gate.closed':
        return String(p.gateId);
      case 'workflow.paused':
      case 'workflow.resumed':
        return String(p.reason);
      default:
        return typeof p.attemptId === 'string' ? p.attemptId : '';
    }
  })();
  return `${event.occurredAt} ${event.type}${detail === '' ? '' : ` ${detail}`}`;
};
