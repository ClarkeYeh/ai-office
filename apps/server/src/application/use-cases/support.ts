import {
  CURRENT_SCHEMA_VERSION,
  ORCA_REQUEST_ID_KINDS,
} from '@ai-office/contracts/events';
import type {
  DomainEventDraft,
  EventPayload,
  EventType,
  ExternalCommand,
} from '@ai-office/contracts/events';
import type { DomainError } from '@ai-office/domain';
import type { Clock, IdGen } from '../../ports/services.js';
import type { IdempotencyStore } from '../../ports/stores.js';
import type {
  WorkflowRunner,
  DispatchResult,
} from '../runner/workflow-runner.js';

export class UseCaseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
export function fail(status: number, code: string, message = code): never {
  throw new UseCaseError(status, code, message);
}
export const check = (result: DispatchResult) => {
  if (!result.ok) throw domainFailure(result.error);
  return result.events;
};
export const domainFailure = (error: DomainError) =>
  new UseCaseError(
    error.category === 'conflict' ? 409 : 422,
    error.code,
    error.message,
    error.details,
  );
export const draft = <T extends EventType>(
  clock: Clock,
  workflowId: string | null,
  type: T,
  payload: EventPayload<T>,
): DomainEventDraft =>
  ({
    type,
    payload,
    workflowId,
    occurredAt: clock.now().toISOString(),
    source: 'user',
    provenance: 'decided',
    schemaVersion: CURRENT_SCHEMA_VERSION[type],
  }) as DomainEventDraft;
export const hash = async (value: string): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;

/** Serialize application preflight work; domain commands still use the runner queue. */
export class Serial {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(scope: string, work: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(scope) ?? Promise.resolve()).then(work);
    const tail = next.catch(() => undefined);
    this.tails.set(scope, tail);
    void tail.then(() => {
      if (this.tails.get(scope) === tail) this.tails.delete(scope);
    });
    return next;
  }
}
export class Idempotency {
  private serial = new Serial();
  constructor(
    private store: IdempotencyStore,
    private clock: Clock,
  ) {}
  run<T>(
    scope: string,
    key: string,
    request: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!key.trim()) fail(422, 'idempotency_key_required');
    return this.serial.run(scope, async () => {
      const requestHash = await hash(JSON.stringify(canonical(request)));
      const prior = this.store.get(scope, key);
      if (prior) {
        if (prior.requestHash !== requestHash)
          fail(409, 'idempotency_mismatch');
        return prior.response.body as T;
      }
      const body = await work();
      this.store.put(scope, key, {
        requestHash,
        response: { status: 200, body },
        expiresAt: new Date(
          this.clock.now().getTime() + 86_400_000,
        ).toISOString(),
      });
      return body;
    });
  }
}
/** Persist the concrete command before the runner executes it; recovery can redo it. */
export const issue = async (
  runner: WorkflowRunner,
  clock: Clock,
  ids: IdGen,
  command: ExternalCommand,
  events: DomainEventDraft[] = [],
) => {
  const idsIssued = await issueBatch(runner, clock, ids, [command], events);
  return idsIssued[0]!;
};

export const issueBatch = async (
  runner: WorkflowRunner,
  clock: Clock,
  ids: IdGen,
  commands: ExternalCommand[],
  events: DomainEventDraft[] = [],
): Promise<string[]> => {
  const pending = commands.map((command) => {
    const commandId = ids.ulid();
    return {
      commandId,
      event: draft(clock, runner.workflowId, 'command.issued', {
        ...command,
        commandId,
        ...((ORCA_REQUEST_ID_KINDS as readonly string[]).includes(command.kind)
          ? { orcaRequestId: ids.orcaRequestId(commandId) }
          : {}),
      }),
    };
  });
  await runner.append([...events, ...pending.map((p) => p.event)]);
  for (const { commandId } of pending) runner.redo(commandId);
  return pending.map((p) => p.commandId);
};
