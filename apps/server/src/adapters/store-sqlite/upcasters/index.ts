import { DomainEventSchema } from '@ai-office/contracts/events';
import type { DomainEvent } from '@ai-office/contracts/events';

export type UpcastPlan = {
  currentVersion: number;
  /** Key is the old version; each step produces the next version's payload. */
  steps: Readonly<Record<number, (payload: unknown) => unknown>>;
};
export type Upcasters = Readonly<
  Partial<Record<DomainEvent['type'], UpcastPlan>>
>;

/** Never rewrite stored events; validate the current payload only after upgrading it. */
export function upcastEvent(
  raw: unknown,
  registry: Upcasters = {},
): DomainEvent {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid stored event');
  const event = { ...raw } as Record<string, unknown>;
  const type = event.type as DomainEvent['type'];
  const plan = registry[type];
  const target = plan?.currentVersion ?? 1;
  let version = event.schemaVersion;
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    version > target
  )
    throw new Error('Unsupported event schema version');
  while (version < target) {
    const step = plan?.steps[version];
    if (!step) throw new Error('Missing event upcaster');
    event.payload = step(event.payload);
    event.schemaVersion = ++version;
  }
  return DomainEventSchema.parse(event);
}
