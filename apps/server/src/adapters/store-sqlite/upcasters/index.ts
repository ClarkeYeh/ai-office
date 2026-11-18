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

/**
 * rev2.10 (M1-CP3) generalised `oncall.*` into `ondemand.*{purpose}` and the
 * `seat.spawned.oncall` flag into `ondemand?: {purpose}` without bumping versions;
 * events stored before that are rewritten here on read.
 */
const LEGACY_ONCALL_TYPES: Readonly<Record<string, DomainEvent['type']>> = {
  'oncall.started': 'ondemand.started',
  'oncall.queue_changed': 'ondemand.queue_changed',
  'oncall.stopped': 'ondemand.stopped',
};
const upgradeLegacyOncall = (event: Record<string, unknown>): void => {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object') return;
  const renamed = LEGACY_ONCALL_TYPES[event.type as string];
  if (renamed !== undefined) {
    event.type = renamed;
    event.payload = { ...payload, purpose: 'oncall' };
  } else if (event.type === 'seat.spawned' && 'oncall' in payload) {
    const { oncall, ...rest } = payload as Record<string, unknown>;
    event.payload =
      oncall === true ? { ...rest, ondemand: { purpose: 'oncall' } } : rest;
  }
};

/** Never rewrite stored events; validate the current payload only after upgrading it. */
export function upcastEvent(
  raw: unknown,
  registry: Upcasters = {},
): DomainEvent {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid stored event');
  const event = { ...raw } as Record<string, unknown>;
  upgradeLegacyOncall(event);
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
