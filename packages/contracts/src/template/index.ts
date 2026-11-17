import { z } from 'zod';

export const AgentKindSchema = z.enum(['claude-code', 'codex']);
export const RoleSchema = z.object({
  agent: AgentKindSchema,
  scope: z.string().max(1000).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
});
export const RoleOverridesSchema = z.record(
  z.string().min(1),
  RoleSchema.omit({ scope: true }),
);
const positive = z.number().int().positive();
export const BudgetSchema = z.object({
  tokens: positive,
  maxTurns: positive.optional(),
  perItem: z
    .object({ tokens: positive, maxTurns: positive.optional() })
    .optional(),
});
export const GateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  optional: z.boolean().optional(),
  editable: z
    .array(z.enum(['title', 'body', 'acceptance', 'role', 'agent', 'deps']))
    .optional(),
});
const id = z.string().min(1);
export const StageSchema = z.discriminatedUnion('kind', [
  z.object({
    id,
    kind: z.literal('meeting'),
    facilitator: id,
    participants: z.array(id).min(1),
    maxRounds: positive,
    timeouts: z.object({ roundMin: positive, stageMin: positive }),
    budget: BudgetSchema,
    conclusion: z.object({ requireTechDecisions: z.boolean() }),
    gate: GateSchema,
  }),
  z.object({
    id,
    kind: z.literal('planning'),
    owner: id,
    from: id,
    timeouts: z.object({ stageMin: positive }),
    budget: BudgetSchema,
    gate: GateSchema,
  }),
  z.object({
    id,
    kind: z.literal('implement'),
    role: id,
    from: id,
    maxParallel: positive,
    timeouts: z.object({ itemMin: positive }),
    budget: BudgetSchema,
    onCall: z.object({ role: id, questionTimeoutMin: positive }),
  }),
  z.object({
    id,
    kind: z.literal('integrate'),
    owner: id,
    escalateOn: z.array(z.enum(['unresolvable-conflict', 'ci-failed-twice'])),
    timeouts: z.object({ stageMin: positive }),
    budget: BudgetSchema,
  }),
  z.object({
    id,
    kind: z.literal('final-pr'),
    maxRevisions: z.number().int().nonnegative(),
    gate: GateSchema,
  }),
]);
export const WorkflowTemplateSchema = z
  .object({
    apiVersion: z.literal('ai-office/v1alpha1'),
    id,
    name: id,
    roles: z.record(id, RoleSchema),
    defaults: z.object({
      integrationBranch: id,
      maxReruns: z.number().int().nonnegative(),
      budget: z.object({ hardLimitMultiplier: z.number().min(1) }),
      workflowBudget: z.object({ tokens: positive }).optional(),
    }),
    stages: z.array(StageSchema).min(1),
  })
  .superRefine((template, ctx) => {
    const stageIds = new Set<string>();
    const gateIds = new Set<string>();
    const order = ['meeting', 'planning', 'implement', 'integrate', 'final-pr'];
    if (template.stages.length !== order.length)
      ctx.addIssue({
        code: 'custom',
        path: ['stages'],
        message: 'All five stage kinds are required, each exactly once',
      });
    template.stages.forEach((stage, index) => {
      const issue = (field: string, message: string) =>
        ctx.addIssue({
          code: 'custom',
          path: ['stages', index, ...field.split('.')],
          message,
        });
      const role = (value: string, field: string) => {
        if (!Object.hasOwn(template.roles, value))
          issue(field, `Unknown role: ${value}`);
      };
      if ('facilitator' in stage) role(stage.facilitator, 'facilitator');
      if ('participants' in stage)
        stage.participants.forEach((value, i) =>
          role(value, `participants.${i}`),
        );
      if ('owner' in stage) role(stage.owner, 'owner');
      if ('role' in stage) role(stage.role, 'role');
      if ('onCall' in stage) role(stage.onCall.role, 'onCall.role');
      if ('from' in stage && !stageIds.has(stage.from))
        issue('from', 'Must reference an upstream stage');
      if (stageIds.has(stage.id)) issue('id', 'Stage ids must be unique');
      stageIds.add(stage.id);
      if (stage.kind !== order[index])
        issue(
          'kind',
          'Stages must follow meeting → planning → implement → integrate → final-pr',
        );
      if ('gate' in stage) {
        if (gateIds.has(stage.gate.id))
          issue('gate.id', 'Gate ids must be unique');
        gateIds.add(stage.gate.id);
      }
      if (stage.kind === 'final-pr') {
        if (index !== template.stages.length - 1)
          issue('kind', 'final-pr must be last');
        if (stage.gate.optional !== undefined)
          issue('gate.optional', 'final-pr gate must not declare optional');
      }
    });
    if (template.stages.at(-1)?.kind !== 'final-pr')
      ctx.addIssue({
        code: 'custom',
        path: ['stages'],
        message: 'Template must end with final-pr',
      });
  });
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;
export type Stage = z.infer<typeof StageSchema>;
export type RoleOverrides = z.infer<typeof RoleOverridesSchema>;
