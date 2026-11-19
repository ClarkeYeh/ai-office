import type { AgentRef } from '../../../ports/refs.js';
import type { RawBlock, RuntimeEvent } from '../../../ports/runtime-events.js';
import { questionRef } from '../refs.js';
import {
  type MailMessage,
  PayloadSchema,
  type TranscriptMessage,
  type Worker,
} from './schemas.js';

export type AgentState =
  'starting' | 'working' | 'waiting_input' | 'idle' | 'exited' | 'stopped';

/** Mailbox `payload` is a JSON string; malformed payloads carry no routing data. */
export function payloadOf(message: MailMessage) {
  try {
    return PayloadSchema.parse(JSON.parse(message.payload ?? 'null'));
  } catch {
    return {};
  }
}
export function dispatchOf(message: MailMessage): string | undefined {
  const payload = payloadOf(message);
  if (payload.dispatchId) return payload.dispatchId;
  return /^dispatch:(\S+)$/.exec(message.from_handle ?? '')?.[1];
}
export function isoOf(value: unknown, fallback: number): string {
  const ms =
    typeof value === 'number'
      ? value < 1e12
        ? value * 1000
        : value
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN;
  return new Date(Number.isNaN(ms) ? fallback : ms).toISOString();
}

/**
 * SPEC §11.1 mailbox mapping. Escalations (including "turn start unobserved"
 * and the post-`ask` `stopReason: finished`) map to nothing: liveness is decided
 * by worker-list only, and stuck agents are the engine's timeouts and nudges.
 */
export function messageEvent(
  message: MailMessage,
  agent: AgentRef,
  fallbackNow: number,
): RuntimeEvent | null {
  const base = {
    agent,
    externalKey: `orca:msg:${message.id}`,
    occurredAt: isoOf(message.created_at, fallbackNow),
  };
  const payload = payloadOf(message);
  if (message.type === 'question')
    return {
      ...base,
      type: 'agent.question',
      question: questionRef(message.id),
      body: payload.question ?? message.body ?? '',
    };
  if (message.type === 'worker_done')
    return {
      ...base,
      type: 'agent.done',
      outcome: payload.outcome === 'succeeded' ? 'success' : 'failure',
      ...(payload.filesModified === undefined
        ? {}
        : { filesModified: payload.filesModified }),
    };
  return null;
}

/**
 * The resource owner is the live dispatch of a follow-up chain; superseded
 * dispatches report `liveness: unverifiable` and no terminal state.
 */
export function currentDispatch(workers: readonly Worker[]): Worker {
  return (
    workers.find((w) => w.resource?.ownerDispatchId === w.dispatchId) ??
    workers[0]!
  );
}
export function workerState(
  worker: Worker,
  waiting: boolean,
  stoppedByBackend = false,
): AgentState {
  const stage = worker.projection.stage;
  if (
    worker.terminalState === 'released' ||
    worker.projection.liveness?.verdict === 'exited'
  )
    return 'exited';
  if ([worker.workerState, stage?.worker].includes('stopped')) return 'stopped';
  // M2-FX12: `worker-stop` on a settled dispatch answers `alreadySettled`
  // and leaves it `succeeded`/`failed`; our stop still has to be observed.
  if (
    stoppedByBackend &&
    ['succeeded', 'failed'].includes(worker.workerState ?? '')
  )
    return 'stopped';
  if (waiting || /wait/i.test(stage?.activity ?? '')) return 'waiting_input';
  if (stage?.activity === 'working') return 'working';
  // A failed worker is not `error`: death is `exited` from liveness (SPEC §6.4).
  if (
    ['succeeded', 'failed'].includes(worker.workerState ?? '') ||
    ['done', 'idle'].includes(stage?.activity ?? '')
  )
    return 'idle';
  if (worker.workerState === 'ready') return 'working';
  return 'starting';
}
/** Displayed stage: a change triggers the `worker-show` agentWait probe. */
export function stageKey(worker: Worker): string {
  const stage = worker.projection.stage;
  return [worker.workerState, stage?.worker, stage?.activity].join('|');
}
export function activitySignature(worker: Worker): string {
  const p = worker.projection;
  return [
    worker.dispatchId,
    worker.workerState,
    worker.terminalState,
    p.stage?.activity,
    p.evidence?.lastObservedAt,
  ].join('|');
}

const str = (value: unknown): string =>
  typeof value === 'string' ? value : value == null ? '' : String(value);
/** Orca's unified transcript blocks → transient RawBlocks (never logged). */
export function rawBlocks(message: TranscriptMessage): RawBlock[] {
  const blocks: RawBlock[] = [];
  for (const block of message.blocks as Record<string, unknown>[]) {
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string')
          blocks.push({ type: 'text', text: block.text });
        break;
      case 'tool_use':
      case 'tool-call':
      case 'tool_call':
        blocks.push({
          type: 'tool_use',
          id: str(block.id ?? block.callId),
          name: str(block.name ?? block.toolName),
          input: block.input ?? block.arguments ?? null,
        });
        break;
      case 'tool_result':
      case 'tool-result': {
        const ok = block.ok ?? (block.isError === true ? false : undefined);
        blocks.push({
          type: 'tool_result',
          toolUseId: str(block.toolUseId ?? block.tool_use_id ?? block.callId),
          output: block.output ?? block.content ?? null,
          ...(typeof ok === 'boolean' ? { ok } : {}),
        });
        break;
      }
    }
  }
  return blocks;
}
export function lastText(message: TranscriptMessage): string | undefined {
  const texts = rawBlocks(message).flatMap((b) =>
    b.type === 'text' ? [b.text] : [],
  );
  return texts.length ? texts.join('\n') : undefined;
}
