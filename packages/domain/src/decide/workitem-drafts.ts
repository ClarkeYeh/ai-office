import type { WorkItemDraftCommand } from '../commands.js';
import { accept, domainError, reject } from '../errors.js';
import type { DecideResult, DomainError } from '../errors.js';
import type { WorkflowState, WorkItemDraft } from '../state/index.js';
import { draft, failed, isDomainError, runningWorkflow } from './support.js';

/** Compare schema fields independently of JSON object insertion order. */
const itemValues = (items: WorkItemDraft[]) =>
  items.map((i) => [
    i.key,
    i.title,
    i.body,
    i.acceptance,
    i.role,
    i.agent,
    i.deps,
  ]);
const sameItems = (a: WorkItemDraft[], b: WorkItemDraft[]) =>
  JSON.stringify(itemValues(a)) === JSON.stringify(itemValues(b));

/** Validate the whole replacement list, including forward references. */
export const validateWorkItemDrafts = (
  state: WorkflowState,
  items: WorkItemDraft[],
): DomainError | undefined => {
  const keys = new Set<string>();
  for (const item of items) {
    if (keys.has(item.key))
      return domainError(
        'validation',
        'duplicate_key',
        'Work-item keys must be unique',
      );
    keys.add(item.key);
    if (!Object.hasOwn(state.workflow?.template.roles ?? {}, item.role))
      return domainError(
        'validation',
        'unknown_role',
        `Unknown role ${item.role}`,
      );
  }
  const graph = new Map(items.map((item) => [item.key, item.deps]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return false;
    if (visited.has(key)) return true;
    visiting.add(key);
    for (const dep of graph.get(key) ?? []) if (!visit(dep)) return false;
    visiting.delete(key);
    visited.add(key);
    return true;
  };
  for (const item of items) {
    if (item.deps.some((dep) => !keys.has(dep)))
      return domainError(
        'validation',
        'unknown_dependency',
        'Dependency must reference the submitted list',
      );
  }
  for (const key of keys)
    if (!visit(key))
      return domainError(
        'validation',
        'dependency_cycle',
        'Work-item dependencies must be acyclic',
      );
  return undefined;
};

export const decideWorkItemDrafts = (
  state: WorkflowState,
  command: WorkItemDraftCommand,
): DecideResult => {
  const workflow = runningWorkflow(state);
  if (isDomainError(workflow)) return failed(workflow);
  const error = validateWorkItemDrafts(state, command.items);
  if (error) return failed(error);
  if (command.type === 'ProposeWorkItems') {
    const stage = state.stages[command.stageId];
    const submission = state.submissions[command.submissionId];
    if (stage?.kind !== 'planning' || stage.status !== 'running')
      return reject(
        'conflict',
        'stage_not_planning',
        'Planning must be running',
      );
    if (
      Object.values(state.gates).some(
        (g) => g.stageId === stage.id && g.status === 'open',
      )
    )
      return reject('conflict', 'gate_open', 'Gate is already open');
    if (
      submission?.submission.kind !== 'work-items' ||
      state.attempts[submission.attemptId]?.stageId !== stage.id ||
      state.attempts[submission.attemptId]?.submissions['work-items'] !==
        submission.id ||
      !sameItems(submission.submission.payload.items, command.items)
    )
      return reject(
        'validation',
        'invalid_proposal',
        'Proposal must match the latest accepted submission',
      );
    return accept(
      draft(
        command.meta,
        { workflowId: workflow.id, stageId: stage.id },
        'workitem.proposed',
        {
          stageId: stage.id,
          submissionId: command.submissionId,
          items: command.items,
        },
      ),
    );
  }
  const gate = state.gates[command.gateId];
  if (
    gate?.kind !== 'stage' ||
    gate.stageKind !== 'planning' ||
    !['approved', 'revised'].includes(gate.status)
  )
    return reject(
      'conflict',
      'gate_not_approved',
      'Planning gate must be approved',
    );
  const expected =
    gate.decision?.edits?.type === 'work-items'
      ? gate.decision.edits.items
      : state.proposals[gate.stageId]?.items;
  const resolved = expected?.map((item) => ({
    ...item,
    agent:
      item.agent ??
      workflow.roleOverrides[item.role]?.agent ??
      workflow.template.roles[item.role]?.agent,
  }));
  if (
    resolved === undefined ||
    !sameItems(resolved as WorkItemDraft[], command.items)
  )
    return reject(
      'validation',
      'approval_mismatch',
      'Items must match the approved list and resolved role agents',
    );
  if (
    Object.values(state.workItems).some(
      (item) => item.approvedGateId === gate.gateId,
    )
  )
    return accept();
  return accept(
    draft(
      command.meta,
      { workflowId: workflow.id, stageId: gate.stageId },
      'workitem.approved',
      { gateId: gate.gateId, items: command.items },
    ),
  );
};
