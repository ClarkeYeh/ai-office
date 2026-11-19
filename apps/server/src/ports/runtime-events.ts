import { z } from 'zod';
import { AgentRefSchema, QuestionRefSchema } from './refs.js';

/** Transient raw data only: never persist these blocks or pass them to Logger. */
export const RawBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolUseId: z.string(),
    output: z.unknown(),
    ok: z.boolean().optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
]);
export type RawBlock = z.infer<typeof RawBlockSchema>;
const envelope = z.object({
  externalKey: z.string().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
});
const agent = envelope.extend({ agent: AgentRefSchema });
export const RawAgentOutputSchema = agent.extend({
  type: z.literal('agent.output'),
  messageId: z.string().min(1),
  role: z.enum(['assistant', 'user', 'tool']),
  blocks: z.array(RawBlockSchema),
});
export type RawAgentOutput = z.infer<typeof RawAgentOutputSchema>;
export const RuntimeEventSchema = z.discriminatedUnion('type', [
  agent.extend({
    type: z.literal('agent.status'),
    state: z.enum([
      'starting',
      'working',
      'waiting_input',
      'idle',
      'done',
      'error',
      'exited',
      'lost',
    ]),
    waitingSince: z.iso.datetime({ offset: true }).optional(),
  }),
  RawAgentOutputSchema,
  agent.extend({
    type: z.literal('agent.question'),
    question: QuestionRefSchema,
    body: z.string(),
  }),
  agent.extend({
    type: z.literal('agent.done'),
    outcome: z.enum(['success', 'failure']),
    filesModified: z.number().int().nonnegative().optional(),
  }),
  agent.extend({ type: z.literal('agent.exited'), reason: z.string() }),
  agent.extend({ type: z.literal('agent.stopped') }),
  agent.extend({
    type: z.literal('agent.rate_limited'),
    evidence: z.enum(['worker-show', 'transcript']),
    resetsAt: z.iso.datetime({ offset: true }).optional(),
  }),
  agent.extend({
    type: z.literal('agent.degraded'),
    reason: z.enum([
      'no_transcript_source',
      'source_changed',
      'transcript_clipped',
    ]),
  }),
  envelope.extend({
    type: z.literal('agent.unmanaged'),
    dispatch: z.string(),
    parentDispatch: z.string().optional(),
    agentKind: z.string().optional(),
    title: z.string().optional(),
  }),
  envelope.extend({
    type: z.literal('runtime.identity_restored'),
    newShim: z.string(),
    runs: z.array(z.string()),
  }),
  envelope.extend({
    type: z.literal('runtime.identity_hijacked'),
    run: z.string(),
    coordinatorHandle: z.string(),
    consumerGeneration: z.number().int().nonnegative(),
  }),
  envelope.extend({
    type: z.literal('runtime.contract_mismatch'),
    command: z.string(),
    issues: z.array(z.string()),
  }),
]);
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;
