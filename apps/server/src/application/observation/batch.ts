import { CURRENT_SCHEMA_VERSION } from '@ai-office/contracts/events';
import type {
  DomainEvent,
  DomainEventDraft,
  EventPayload,
  EventType,
} from '@ai-office/contracts/events';
import { decide, evolve } from '@ai-office/domain';
import type {
  Attempt,
  DomainCommand,
  EvaluateAnomaly,
  WorkflowState,
} from '@ai-office/domain';
import type { CursorWrite, EventStore } from '../../ports/stores.js';

export interface ObservationWorkflow {
  readonly workflowId: string;
  readonly state: WorkflowState;
  append(
    drafts: DomainEventDraft[],
    cursors?: CursorWrite[],
  ): Promise<DomainEvent[]>;
}
export type Observation = { externalKey: string; occurredAt: string };

/** Derive a whole batch against a private evolving snapshot, then commit once.
 * Suffix every derived event: one source observation can yield several events.
 */
export class Batch {
  state: WorkflowState;
  readonly drafts: DomainEventDraft[] = [];
  private readonly keys: Set<string>;
  constructor(
    readonly runner: ObservationWorkflow,
    store: EventStore,
  ) {
    this.state = runner.state;
    this.keys = new Set(
      store
        .read({ workflowId: runner.workflowId })
        .flatMap((e) => (e.externalKey === undefined ? [] : [e.externalKey])),
    );
  }
  observed(key: string): boolean {
    return [...this.keys].some((k) => k.startsWith(`${key}:`));
  }
  has(key: string): boolean {
    return this.keys.has(key);
  }
  add<T extends EventType>(
    type: T,
    payload: EventPayload<T>,
    observation: Observation,
    source: 'runtime' | 'scm' | 'system',
    attempt?: Attempt,
    suffix: string = type,
  ): void {
    this.push({
      type,
      payload,
      workflowId: this.runner.workflowId,
      occurredAt: observation.occurredAt,
      source,
      provenance: 'observed',
      schemaVersion: CURRENT_SCHEMA_VERSION[type],
      externalKey:
        suffix === ''
          ? observation.externalKey
          : `${observation.externalKey}:${suffix}`,
      ...(attempt === undefined
        ? {}
        : {
            attemptId: attempt.attemptId,
            seatId: attempt.seatId,
            stageId: attempt.stageId,
          }),
    } as DomainEventDraft);
  }
  command(command: DomainCommand, observation: Observation): void {
    const result = decide(this.state, command);
    if (!result.ok)
      throw new Error(`Observation rejected: ${result.error.code}`);
    result.events.forEach((draft, index) =>
      this.push({
        ...draft,
        externalKey: `${observation.externalKey}:${draft.type}:${index}`,
      }),
    );
  }
  anomaly(
    observation: EvaluateAnomaly['observation'],
    event: Observation,
    source: 'runtime' | 'scm',
  ): void {
    this.command(
      {
        type: 'EvaluateAnomaly',
        observation,
        meta: { occurredAt: event.occurredAt, source, provenance: 'observed' },
      },
      event,
    );
  }
  private push(draft: DomainEventDraft): void {
    if (draft.externalKey !== undefined && this.keys.has(draft.externalKey))
      return;
    if (draft.externalKey !== undefined) this.keys.add(draft.externalKey);
    this.drafts.push(draft);
    // Only the private reducer needs an envelope; the EventStore assigns real ids/seq.
    this.state = evolve(this.state, {
      ...draft,
      seq: this.state.lastSeq + 1,
      id: '00000000000000000000000000',
      recordedAt: draft.occurredAt,
    } as DomainEvent);
  }
}
