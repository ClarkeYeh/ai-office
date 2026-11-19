import { z } from 'zod';
import { completeTaskList } from '../ledger.js';

/** Orca 1.4.259 shapes (fixtures/orca/1.4.259). Loose: only read fields are pinned. */
export const MailMessageSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string(),
  from_handle: z.string().nullish(),
  thread_id: z.string().nullish(),
  body: z.string().nullish(),
  payload: z.string().nullish(),
  created_at: z.string(),
  /** Inbox only; consuming `check` messages carry no sequence (day-1 P6). */
  sequence: z.number().int().nonnegative().optional(),
});
export type MailMessage = z.infer<typeof MailMessageSchema>;
export const CheckResultSchema = z.looseObject({
  messages: z.array(MailMessageSchema),
  deliveryId: z.string().nullish(),
  timedOut: z.boolean().nullish(),
  cancelled: z.boolean().nullish(),
  connectionLost: z.boolean().nullish(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;
export const InboxResultSchema = z.looseObject({
  messages: z.array(
    MailMessageSchema.extend({ sequence: z.number().int().nonnegative() }),
  ),
});
/**
 * Each field degrades on its own (M2-FX12 D11): one unexpected optional field
 * must never discard the routing fields. `orchestration send --files-modified`
 * records a path list; the port carries only its count.
 */
export const PayloadSchema = z.looseObject({
  dispatchId: z.string().optional().catch(undefined),
  taskId: z.string().optional().catch(undefined),
  outcome: z.string().optional().catch(undefined),
  question: z.string().optional().catch(undefined),
  filesModified: z
    .union([
      z.number().int().nonnegative(),
      z.array(z.string()).transform((paths) => paths.length),
    ])
    .optional()
    .catch(undefined),
});
export const RequestShowSchema = z.looseObject({
  state: z.string(),
});
const Resource = z
  .looseObject({
    ownerDispatchId: z.string().nullish(),
    originDispatchId: z.string().nullish(),
    retainedReason: z.string().nullish(),
  })
  .nullish();
export const WorkerSchema = z.looseObject({
  dispatchId: z.string().min(1),
  taskId: z.string(),
  runId: z.string(),
  workerState: z.string().nullish(),
  dispatchStatus: z.string().nullish(),
  terminalState: z.string().nullish(),
  followUpOf: z.string().nullish(),
  agentTerminalHandle: z.string().nullish(),
  terminal: z.string().nullish(),
  resource: Resource,
  projection: z.looseObject({
    parent: z.unknown().nullish(),
    provider: z.looseObject({ id: z.string().nullish() }).nullish(),
    stage: z
      .looseObject({
        worker: z.string().nullish(),
        activity: z.string().nullish(),
      })
      .nullish(),
    liveness: z.looseObject({ verdict: z.string().nullish() }).nullish(),
    evidence: z.looseObject({ lastObservedAt: z.number().nullish() }).nullish(),
  }),
});
export type Worker = z.infer<typeof WorkerSchema>;
export const WorkerListSchema = z.looseObject({
  workers: z.array(WorkerSchema),
});
export const TaskListSchema = z
  .looseObject({
    tasks: z.array(
      z.looseObject({
        id: z.string(),
        title: z.string(),
        runId: z.string().optional(),
      }),
    ),
  })
  .refine(completeTaskList);
export const WorkerShowSchema = z.looseObject({
  observation: z.looseObject({ agentWait: z.unknown() }).nullish(),
});
const TranscriptMessage = z.looseObject({
  id: z.string().min(1),
  role: z.string(),
  blocks: z.array(z.looseObject({ type: z.string() })).default([]),
  timestamp: z.union([z.string(), z.number()]).nullish(),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessage>;
/** Top-level fields per the M0.5 spike; transcript text is never recorded as a fixture. */
export const WorkerReadSchema = z.looseObject({
  source: z.string().nullish(),
  fallbackReason: z.string().nullish(),
  cursor: z.string().nullish(),
  contentComplete: z.boolean().nullish(),
  transcript: z
    .union([
      z.array(TranscriptMessage),
      z.looseObject({ messages: z.array(TranscriptMessage) }),
    ])
    .nullish(),
});
export type WorkerRead = z.infer<typeof WorkerReadSchema>;

/** Validation issues without input values: paths and codes only (§20). */
export function issueSummary(error: z.ZodError): string[] {
  return error.issues
    .slice(0, 10)
    .map(
      (issue) =>
        `${issue.path.map(String).join('.') || '<root>'}:${issue.code}`,
    );
}
