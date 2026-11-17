import { z } from 'zod';
import { AgentKindSchema } from '../template/index.js';
import { GitShaSchema, id, positiveInt, WorkItemKeySchema } from './common.js';

// Submission payloads live here so domain can validate them without contracts/agent-submission (§9.1).
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
  key: WorkItemKeySchema,
  title: z.string(),
  body: z.string(),
  acceptance: z.array(z.string()),
  role: id,
  agent: AgentKindSchema.optional(),
  deps: z.array(WorkItemKeySchema),
});
export const AgendaSchema = z.object({
  topics: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        focusByRole: z.record(z.string(), z.string()),
      }),
    )
    .min(1),
});
export const StatementSchema = z.object({
  round: positiveInt,
  position: z.string(),
  arguments: z.array(z.string()),
  concerns: z.array(z.string()),
  readyToConclude: z.boolean(),
});
export const WorkItemsSubmissionSchema = z.object({
  items: z.array(WorkItemDraftSchema),
});
export const AnswerQuestionSchema = z.object({
  questionId: id,
  body: z.string(),
});
export const MergeRequestSchema = z.object({
  pr: positiveInt,
  expectedHeadSha: GitShaSchema,
});
/** rev2.10 §7.4a: the merge-queue integrator sends the PR back to its worker branch. */
export const ReworkRequestSchema = z.object({
  pr: positiveInt,
  reasons: z.array(z.string().min(1)).min(1),
});
export const DecisionRequestReasonSchema = z.enum([
  'unresolvable-conflict',
  'scope-change',
  'conflicts-with-conclusion',
  'other',
]);
export const DecisionRequestSchema = z.object({
  reason: DecisionRequestReasonSchema,
  question: z.string(),
  // §8.3: at most four agent options; the gate always adds "abort".
  options: z.array(z.string()).max(4),
  questionId: id.optional(),
});
export const IntegrationReportSchema = z.object({
  summary: z.string(),
  merged: z.array(positiveInt),
  verification: z.array(z.object({ command: z.string(), ok: z.boolean() })),
  risks: z.array(z.string()),
});

export const SUBMISSION_KINDS = [
  'agenda',
  'statement',
  'conclusion',
  'work-items',
  'answer-question',
  'merge-request',
  'rework-request',
  'decision-request',
  'integration-report',
] as const;
export const SubmissionKindSchema = z.enum(SUBMISSION_KINDS);
export const AgentSubmissionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agenda'), payload: AgendaSchema }),
  z.object({ kind: z.literal('statement'), payload: StatementSchema }),
  z.object({ kind: z.literal('conclusion'), payload: ConclusionSchema }),
  z.object({
    kind: z.literal('work-items'),
    payload: WorkItemsSubmissionSchema,
  }),
  z.object({
    kind: z.literal('answer-question'),
    payload: AnswerQuestionSchema,
  }),
  z.object({ kind: z.literal('merge-request'), payload: MergeRequestSchema }),
  z.object({ kind: z.literal('rework-request'), payload: ReworkRequestSchema }),
  z.object({
    kind: z.literal('decision-request'),
    payload: DecisionRequestSchema,
  }),
  z.object({
    kind: z.literal('integration-report'),
    payload: IntegrationReportSchema,
  }),
]);

export type Conclusion = z.infer<typeof ConclusionSchema>;
export type WorkItemDraft = z.infer<typeof WorkItemDraftSchema>;
export type Agenda = z.infer<typeof AgendaSchema>;
export type Statement = z.infer<typeof StatementSchema>;
export type ReworkRequest = z.infer<typeof ReworkRequestSchema>;
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;
export type IntegrationReport = z.infer<typeof IntegrationReportSchema>;
export type AgentSubmission = z.infer<typeof AgentSubmissionSchema>;
export type SubmissionKind = AgentSubmission['kind'];
