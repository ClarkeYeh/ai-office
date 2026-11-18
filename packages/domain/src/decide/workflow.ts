import type { EventPayload } from '@ai-office/contracts/events';
import type { WorkflowTemplate } from '@ai-office/contracts/template';
import type {
  BudgetOverrides,
  StartWorkflow,
  WorkflowCommand,
} from '../commands.js';
import { accept, domainError, reject } from '../errors.js';
import type { DecideResult, DomainError } from '../errors.js';
import { stageByKind } from '../state/index.js';
import type { AppliedBudgets, WorkflowState } from '../state/index.js';
import {
  defined,
  draft,
  failed,
  isDomainError,
  runningWorkflow,
} from './support.js';

const SLUG_MAX_LENGTH = 32;

/** Deterministic, branch-safe slug; non-ASCII text falls back to `fallback`. */
export const slugify = (text: string, fallback = 'workflow'): string => {
  const slug = (value: string) =>
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, SLUG_MAX_LENGTH)
      .replace(/-+$/, '');
  return slug(text) || slug(fallback) || 'workflow';
};

const SAFE_BRANCH = /^ai-office\/[A-Za-z0-9._/-]+$/;

/** `defaults.integrationBranch` with `{shortId}` / `{slug}` filled in (§16.3). */
export const integrationBranchName = (
  pattern: string,
  values: { shortId: string; slug: string },
): string | DomainError => {
  const name = pattern
    .replaceAll('{shortId}', values.shortId)
    .replaceAll('{slug}', values.slug);
  if (
    !SAFE_BRANCH.test(name) ||
    name.includes('..') ||
    name.includes('//') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.endsWith('.lock')
  )
    return domainError(
      'validation',
      'invalid_integration_branch',
      `Integration branch pattern yields an invalid name: ${name}`,
      { pattern, name },
    );
  return name;
};

const applyBudgets = (
  template: WorkflowTemplate,
  overrides: BudgetOverrides = {},
): AppliedBudgets | DomainError => {
  const stages: AppliedBudgets['stages'] = {};
  for (const stage of template.stages)
    if ('budget' in stage)
      stages[stage.id] = {
        ...stage.budget,
        ...defined(overrides.stages?.[stage.id] ?? {}),
      };
  const unknown = Object.keys(overrides.stages ?? {}).filter(
    (id) => !Object.hasOwn(stages, id),
  );
  if (unknown.length > 0)
    return domainError(
      'validation',
      'unknown_budget_stage',
      `Budget overrides name stages without a budget: ${unknown.join(', ')}`,
      { stages: unknown },
    );
  const workflow = overrides.workflowBudget ?? template.defaults.workflowBudget;
  return {
    stages,
    ...(workflow === undefined ? {} : { workflow }),
    hardLimitMultiplier:
      overrides.hardLimitMultiplier ??
      template.defaults.budget.hardLimitMultiplier,
  };
};

/** Every optional gate, enabled unless toggled off; only optional gates may be named. */
const applyGateToggles = (
  template: WorkflowTemplate,
  toggles: Record<string, boolean> = {},
): Record<string, boolean> | DomainError => {
  const optional = template.stages.flatMap((stage) =>
    'gate' in stage && stage.gate.optional === true ? [stage.gate.id] : [],
  );
  const invalid = Object.keys(toggles).filter((id) => !optional.includes(id));
  if (invalid.length > 0)
    return domainError(
      'validation',
      'gate_not_optional',
      `Only optional gates can be toggled: ${invalid.join(', ')}`,
      { gates: invalid, optional },
    );
  return Object.fromEntries(optional.map((id) => [id, toggles[id] ?? true]));
};

const startWorkflow = (
  state: WorkflowState,
  command: StartWorkflow,
): DecideResult => {
  if (state.workflow !== null)
    return reject(
      'conflict',
      'workflow_exists',
      'Workflow has already started',
    );
  if (!/^[a-z0-9]{4,12}$/.test(command.shortId))
    return reject(
      'validation',
      'invalid_short_id',
      'shortId must be 4–12 of [a-z0-9]',
    );
  const requirement = command.requirement.trim();
  if (requirement === '')
    return reject(
      'validation',
      'empty_requirement',
      'Requirement must not be empty',
    );
  const { template } = command;
  const roleOverrides = command.roleOverrides ?? {};
  const unknownRoles = Object.keys(roleOverrides).filter(
    (role) => !Object.hasOwn(template.roles, role),
  );
  if (unknownRoles.length > 0)
    return reject(
      'validation',
      'unknown_role',
      `Role overrides name unknown roles: ${unknownRoles.join(', ')}`,
      { roles: unknownRoles },
    );
  const gateToggles = applyGateToggles(template, command.gateToggles);
  if (isDomainError(gateToggles)) return failed(gateToggles);
  const budgets = applyBudgets(template, command.budgetOverrides);
  if (isDomainError(budgets)) return failed(budgets);
  const integrationBranch = integrationBranchName(
    template.defaults.integrationBranch,
    { shortId: command.shortId, slug: slugify(requirement, template.id) },
  );
  if (isDomainError(integrationBranch)) return failed(integrationBranch);
  return accept(
    draft(
      command.meta,
      { workflowId: command.workflowId },
      'workflow.started',
      {
        templateSnapshot: template,
        repo: command.repo,
        requirement,
        shortId: command.shortId,
        integrationBranch,
        roleOverrides,
        gateToggles,
        budgets,
        limits: command.limits,
        acknowledgedUnverifiedRuntime:
          command.acknowledgedUnverifiedRuntime ?? false,
      },
    ),
  );
};

export const decideWorkflow = (
  state: WorkflowState,
  command: WorkflowCommand,
): DecideResult => {
  if (command.type === 'StartWorkflow') return startWorkflow(state, command);
  const workflow = runningWorkflow(state);
  if (isDomainError(workflow)) return failed(workflow);
  const scope = { workflowId: workflow.id };
  switch (command.type) {
    case 'PauseWorkflow':
      // Idempotent: each reason pauses once and resumes independently.
      if (workflow.pausedReasons.includes(command.reason)) return accept();
      return accept(
        draft(command.meta, scope, 'workflow.paused', {
          reason: command.reason,
          ...defined({ gateId: command.gateId, detail: command.detail }),
        }),
      );
    case 'ResumeWorkflow':
      if (!workflow.pausedReasons.includes(command.reason)) return accept();
      return accept(
        draft(command.meta, scope, 'workflow.resumed', {
          reason: command.reason,
        }),
      );
    case 'RequestCancel':
      if (workflow.cancelRequested) return accept();
      return accept(
        draft(command.meta, scope, 'workflow.cancel_requested', {
          by: command.by,
          ...defined({ gateId: command.gateId, reason: command.reason }),
        }),
      );
    case 'MarkCancelled':
      if (!workflow.cancelRequested)
        return reject(
          'conflict',
          'cancel_not_requested',
          'Cancel was not requested',
        );
      return accept(
        draft(
          command.meta,
          scope,
          'workflow.cancelled',
          defined({ reason: command.reason }),
        ),
      );
    case 'CompleteWorkflow': {
      const finalPr = stageByKind(state, 'final-pr');
      if (finalPr === undefined || finalPr.attempt === 0)
        return reject(
          'conflict',
          'final_pr_not_started',
          'Final PR stage has not started',
        );
      const payload: EventPayload<'workflow.completed'> = {
        finalPr: command.finalPr,
        ...defined({ mergeCommitSha: command.mergeCommitSha }),
      };
      return accept(draft(command.meta, scope, 'workflow.completed', payload));
    }
    case 'FailWorkflow':
      if (
        command.stageId !== undefined &&
        !Object.hasOwn(state.stages, command.stageId)
      )
        return reject(
          'validation',
          'unknown_stage',
          `No stage ${command.stageId}`,
        );
      return accept(
        draft(command.meta, scope, 'workflow.failed', {
          reason: command.reason,
          ...defined({ stageId: command.stageId, detail: command.detail }),
        }),
      );
  }
};
