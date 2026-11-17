import { z } from 'zod';
import { AgentKindSchema } from '../template/index.js';

export const ConclusionSchema = z.object({
  summary: z.string(),
  decisions: z.array(z.object({ title: z.string(), rationale: z.string() })),
  techDecisions: z.array(
    z.object({
      topic: z.string(),
      options: z.array(z.string()),
      chosen: z.string(),
      rationale: z.string(),
    }),
  ),
  openQuestions: z.array(z.string()),
});
export const WorkItemDraftSchema = z.object({
  key: z.string().min(1),
  title: z.string(),
  body: z.string(),
  acceptance: z.array(z.string()),
  role: z.string().min(1),
  agent: AgentKindSchema.optional(),
  deps: z.array(z.string()),
});
export const AgentSubmissionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agenda'),
    payload: z.object({
      topics: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          focusByRole: z.record(z.string(), z.string()),
        }),
      ),
    }),
  }),
  z.object({
    kind: z.literal('statement'),
    payload: z.object({
      round: z.number().int().positive(),
      position: z.string(),
      arguments: z.array(z.string()),
      concerns: z.array(z.string()),
      readyToConclude: z.boolean(),
    }),
  }),
  z.object({ kind: z.literal('conclusion'), payload: ConclusionSchema }),
  z.object({
    kind: z.literal('work-items'),
    payload: z.object({ items: z.array(WorkItemDraftSchema) }),
  }),
  z.object({
    kind: z.literal('answer-question'),
    payload: z.object({ questionId: z.string(), body: z.string() }),
  }),
  z.object({
    kind: z.literal('merge-request'),
    payload: z.object({
      pr: z.number().int().positive(),
      expectedHeadSha: z.string().min(1),
    }),
  }),
  z.object({
    kind: z.literal('decision-request'),
    payload: z.object({
      reason: z.enum([
        'unresolvable-conflict',
        'scope-change',
        'conflicts-with-conclusion',
        'other',
      ]),
      question: z.string(),
      options: z.array(z.string()),
      questionId: z.string().optional(),
    }),
  }),
  z.object({
    kind: z.literal('integration-report'),
    payload: z.object({
      summary: z.string(),
      merged: z.array(z.number().int().positive()),
      verification: z.array(z.object({ command: z.string(), ok: z.boolean() })),
      risks: z.array(z.string()),
    }),
  }),
]);
export const CLI_EXIT_CODES = {
  SUCCESS: 0,
  SCHEMA_ERROR: 2,
  IDENTITY_OR_STATE_ERROR: 3,
  BACKEND_UNREACHABLE: 4,
} as const;
export const SubmissionResponseSchema = z.union([
  z.object({ submissionId: z.string() }),
  z.object({
    merged: z.boolean(),
    pr: z.number().int().positive(),
    sha: z.string().optional(),
  }),
]);
export type AgentSubmission = z.infer<typeof AgentSubmissionSchema>;
export type SubmissionKind = AgentSubmission['kind'];
export type Conclusion = z.infer<typeof ConclusionSchema>;
export type WorkItemDraft = z.infer<typeof WorkItemDraftSchema>;
