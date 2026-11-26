import {
  EVENT_TYPES,
  type DomainEvent,
  type EventType,
} from '@ai-office/contracts/events';
import { evolve, type ReadModel } from '@ai-office/projection';

// M5-T17 (M5_PLAN §5, §6.2): the masked joint-run export as a web fixture.
// `fixtures/web/m5-joint.events.json` is T12's production run (1812 events),
// masked with T0's `exportJointEvents` (opaque Orca ids and UUIDs
// pseudonymized); `M5_JOINT_RESTART_SEQ` is the first event after the
// restart. It keeps the run's duplicate `seat.activity` re-emissions: that is
// what was recorded.
//
// The export masks every string outside T0's allowlist (`‹text len= sha=›`,
// including ids and timestamps), so events are not schema-checked here: the
// loader checks the envelope only and folds with the real projection.

export const M5_JOINT_FIXTURE = new URL(
  '../../../../../fixtures/web/m5-joint.events.json',
  import.meta.url,
);

/** The first seq after the joint run's kill and restart (K at 991). */
export const M5_JOINT_RESTART_SEQ = 1012;

/** T0's free-text placeholder (`textPlaceholder` in the joint export). */
export const PLACEHOLDER = /^‹text len=\d+ sha=[0-9a-f]{12}›$/;

/** T0's export normalizes every timestamp onto this epoch. */
const EXPORT_EPOCH = '2000-01-01T00:00:00.000Z';

export interface JointExport {
  exportedAt: string;
  aiOfficeCommit: string;
  orcaVersion: string;
  events: DomainEvent[];
}

export interface JointLog extends JointExport {
  /** Read model after each event, index-aligned with `events`. */
  models: ReadModel[];
  restartSeq: number;
  /** Read model after the last event at or before `seq`. */
  modelAt(seq: number): ReadModel;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Envelope checks only (see above); throws on anything a fold cannot use. */
export function parseJointExport(text: string): JointExport {
  const data: unknown = JSON.parse(text);
  if (!isObject(data) || !Array.isArray(data.events))
    throw new Error('Not a joint export: no events');
  if (data.exportedAt !== EXPORT_EPOCH)
    throw new Error('Not a masked joint export');
  if (
    typeof data.aiOfficeCommit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(data.aiOfficeCommit)
  )
    throw new Error('Invalid aiOfficeCommit');
  if (typeof data.orcaVersion !== 'string')
    throw new Error('Invalid orcaVersion');
  let seq = 0;
  let workflowId: unknown;
  for (const event of data.events as unknown[]) {
    if (!isObject(event) || !isObject(event.payload))
      throw new Error('Invalid event');
    if (typeof event.seq !== 'number' || event.seq <= seq)
      throw new Error(`Seq not strictly increasing at ${String(event.seq)}`);
    seq = event.seq;
    if (!EVENT_TYPES.includes(event.type as EventType))
      throw new Error(`Unknown event type at seq ${seq}`);
    if (!Number.isFinite(Date.parse(String(event.recordedAt))))
      throw new Error(`Invalid recordedAt at seq ${seq}`);
    workflowId ??= event.workflowId;
    if (event.workflowId !== workflowId)
      throw new Error(`Second workflow at seq ${seq}`);
  }
  if (
    (data.events[0] as { type?: unknown } | undefined)?.type !==
    'workflow.started'
  )
    throw new Error('The export does not start with workflow.started');
  return data as unknown as JointExport;
}

/** Folds the export with the real projection, as the live view would. */
export function foldJointExport(
  data: JointExport,
  restartSeq: number,
): JointLog {
  const models: ReadModel[] = [];
  let model: ReadModel | null = null;
  for (const event of data.events) {
    model = evolve(model, event);
    if (!model) throw new Error(`No read model after seq ${event.seq}`);
    models.push(model);
  }
  return {
    ...data,
    models,
    restartSeq,
    modelAt(seq) {
      const index = data.events.findLastIndex((e) => e.seq <= seq);
      if (index < 0) throw new Error(`No event at or before seq ${seq}`);
      return models[index]!;
    },
  };
}
