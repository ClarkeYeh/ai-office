import type { ActivityMeta, PolicyHit } from '@ai-office/contracts/events';
import type { RawAgentOutput } from './runtime-events.js';
export type { ActivityMeta, PolicyHit } from '@ai-office/contracts/events';
export interface Redactor {
  toActivity(output: RawAgentOutput): {
    activity: ActivityMeta[];
    policyHits: PolicyHit[];
  };
  maskSecrets<T>(value: T): T;
}
export interface Clock {
  now(): Date;
}
export type ScheduledTimer = { id: string; workflowId: string; fireAt: string };
export interface Scheduler {
  schedule(timer: ScheduledTimer): void;
  cancel(id: string): void;
}
/** Fixed namespace shared by production and deterministic test implementations. */
export const AIO_NAMESPACE = 'de8da250-5d38-5e9f-9709-4f139d21cbf3';
export interface IdGen {
  ulid(): string;
  shortId(): string;
  /** UUIDv5(AIO_NAMESPACE, commandId), stable across restarts. */
  orcaRequestId(commandId: string): string;
}
export type LogBindings = Record<string, unknown>;
export interface Logger {
  child(bindings: LogBindings): Logger;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}
