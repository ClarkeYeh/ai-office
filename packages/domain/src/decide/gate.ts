import type { DomainEventDraft } from '@ai-office/contracts/events';
import type { GateCommand, DecideGate } from '../commands.js';
import { accept, reject } from '../errors.js';
import type { DecideResult } from '../errors.js';
import type { Gate, Workflow, WorkflowState } from '../state/index.js';
import {
  defined,
  draft,
  failed,
  isDomainError,
  runningWorkflow,
} from './support.js';
import { WORKITEM_EXCEPTION_OPTIONS, workItemGateEffects } from './workitem.js';
import { validateWorkItemDrafts } from './workitem-drafts.js';

/** Stable option IDs shared with engine callers; labels remain presentation data. */
export const EXCEPTION_OPTIONS = {
  ...WORKITEM_EXCEPTION_OPTIONS,
  'stage-violation': ['rerun', 'reassign', 'abort'],
  'spawn-stall': ['retry', 'reassign', 'abort'],
  'workitem-failed': ['retry', 'reassign', 'skip', 'abort'],
  'budget-exceeded': ['top-up', 'finish', 'abort'],
  'budget-hard-limit': ['top-up-rerun', 'use-output', 'abort'],
  'item-budget-exceeded': ['top-up', 'finish', 'skip', 'abort'],
  'item-budget-hard-limit': [
    'top-up-rerun',
    'use-output',
    'retry',
    'reassign',
    'skip',
    'abort',
  ],
  anomaly: ['continue', 'stop-again', 'abort'],
  hijacked: ['reclaim', 'abort'],
} as const;

const decide = (
  state: WorkflowState,
  workflow: Workflow,
  gate: Gate,
  command: DecideGate,
): DecideResult => {
  if (command.expectedVersion !== gate.version)
    return reject(
      'conflict',
      'gate_version_conflict',
      'Gate content version changed',
    );
  const scope = { workflowId: workflow.id, stageId: gate.stageId };
  const events: DomainEventDraft[] = [];
  if (gate.kind === 'exception') {
    if (gate.exceptionKind === 'question-escalation')
      return reject(
        'validation',
        'answer_question_required',
        'Use AnswerQuestion for escalated questions',
      );
    if (
      command.by !== 'user' ||
      command.decision !== 'option' ||
      !gate.options.some((o) => o.optionId === command.optionId)
    )
      return reject(
        'validation',
        'invalid_gate_decision',
        'Choose an offered exception option',
      );
    if (
      (command.optionId === 'top-up' || command.optionId === 'top-up-rerun') &&
      (!Number.isSafeInteger(command.additionalTokens) ||
        (command.additionalTokens ?? 0) <= 0)
    )
      return reject(
        'validation',
        'tokens_required',
        'A positive token amount is required',
      );
    if (command.optionId === 'reassign' && command.agent === undefined)
      return reject(
        'validation',
        'agent_required',
        'Reassignment requires an agent',
      );
  } else {
    const config = workflow.template.stages.find((s) => s.id === gate.stageId);
    const stage = state.stages[gate.stageId];
    if (!config || !('gate' in config) || !stage)
      return reject('validation', 'unknown_stage', 'Gate stage is missing');
    if (
      command.by === 'auto' &&
      !(
        gate.optional &&
        workflow.gateToggles[gate.templateGateId] === false &&
        command.decision === 'approve'
      )
    )
      return reject(
        'validation',
        'auto_not_allowed',
        'Only disabled optional gates can auto-approve',
      );
    if (gate.stageKind === 'final-pr') {
      const integrate = Object.values(state.stages).find(
        (s) => s.kind === 'integrate',
      );
      if (command.decision === 'reject') {
        if (
          !integrate ||
          config.kind !== 'final-pr' ||
          integrate.revisions >= config.maxRevisions
        )
          return reject(
            'conflict',
            'max_revisions_exceeded',
            'Only keep-open or abort remains',
          );
        events.push(
          draft(
            command.meta,
            { ...scope, stageId: integrate.id },
            'stage.rerun_requested',
            {
              stageId: integrate.id,
              fromAttempt: integrate.attempt,
              mode: 'revision',
              by: command.by,
              gateId: gate.gateId,
              ...defined({ feedback: command.comment }),
            },
          ),
        );
      } else if (
        command.decision !== 'option' ||
        !['keep-open', 'abort'].includes(command.optionId ?? '')
      )
        return reject(
          'validation',
          'invalid_gate_decision',
          'Final PR completes only when merged',
        );
    } else {
      if (command.optionId !== undefined)
        return reject(
          'validation',
          'invalid_gate_decision',
          'Stage decisions do not take an option',
        );
      if (!['approve', 'revise', 'reject'].includes(command.decision))
        return reject(
          'validation',
          'invalid_gate_decision',
          'Stage gate requires approve, revise or reject',
        );
      if (command.decision === 'revise') {
        if (!command.edits || command.edits.type !== gate.content.type)
          return reject(
            'validation',
            'edits_required',
            'Matching edits are required',
          );
        // Conclusion fields are explicitly editable in §8.2; template.editable
        // enumerates only work-item fields in the v1alpha1 template contract.
        if (command.edits.type === 'work-items') {
          const error = validateWorkItemDrafts(state, command.edits.items);
          if (error) return failed(error);
          const originals = state.proposals[gate.stageId]?.items ?? [];
          const editable = new Set<string>(config.gate.editable ?? []);
          for (const item of command.edits.items) {
            const original = originals.find((i) => i.key === item.key);
            for (const field of [
              'title',
              'body',
              'acceptance',
              'role',
              'agent',
              'deps',
            ] as const)
              if (
                !editable.has(field) &&
                JSON.stringify(item[field]) !==
                  JSON.stringify(original?.[field])
              )
                return reject(
                  'validation',
                  'field_not_editable',
                  `Field ${field} is not editable`,
                );
          }
        }
      } else if (command.edits !== undefined)
        return reject('validation', 'unexpected_edits', 'Edits require revise');
      if (
        gate.stageKind === 'meeting' &&
        ['approve', 'revise'].includes(command.decision) &&
        command.by === 'user'
      ) {
        if (
          !command.requestedGithubBodyHash ||
          command.requestedGithubBodyHash !== command.currentGithubBodyHash
        )
          return reject(
            'conflict',
            'gate_content_changed',
            'GitHub body changed',
          );
        if (
          !command.approvedSnapshot ||
          (command.decision === 'approve' &&
            command.approvedSnapshot.bodyHash !== command.currentGithubBodyHash)
        )
          return reject(
            'validation',
            'snapshot_required',
            'Approved conclusion snapshot is required',
          );
      }
      if (command.decision === 'reject') {
        events.push(
          stage.reruns >= workflow.template.defaults.maxReruns
            ? draft(command.meta, scope, 'workflow.failed', {
                reason: 'max_reruns_exceeded',
                stageId: stage.id,
              })
            : draft(command.meta, scope, 'stage.rerun_requested', {
                stageId: stage.id,
                fromAttempt: stage.attempt,
                mode: 'rerun',
                by: command.by,
                gateId: gate.gateId,
                ...defined({ feedback: command.comment }),
              }),
        );
      }
    }
  }
  events.push(...workItemGateEffects(state, gate, command));
  if (command.decision === 'option' && command.optionId === 'abort')
    events.push(
      draft(command.meta, scope, 'workflow.cancel_requested', {
        by: 'gate',
        gateId: gate.gateId,
      }),
    );
  return accept(
    draft(command.meta, scope, 'gate.decided', {
      gateId: gate.gateId,
      version: gate.version,
      decision: command.decision,
      by: command.by,
      ...defined({
        optionId: command.optionId,
        comment: command.comment,
        edits: command.edits,
        approvedSnapshot: command.approvedSnapshot,
        additionalTokens: command.additionalTokens,
        agent: command.agent,
      }),
    }),
    ...events,
  );
};

export const decideGate = (
  state: WorkflowState,
  command: GateCommand,
): DecideResult => {
  const workflow = runningWorkflow(state);
  if (isDomainError(workflow)) return failed(workflow);
  if (command.type === 'OpenGate') {
    const gate = command.gate;
    const stage = state.stages[gate.stageId];
    if (!stage)
      return reject('validation', 'unknown_stage', 'Unknown gate stage');
    if (Object.hasOwn(state.gates, gate.gateId))
      return reject('conflict', 'duplicate_gate', 'Gate id already exists');
    if (workflow.cancelRequested)
      return reject('conflict', 'cancel_requested', 'Workflow is cancelling');
    if (gate.kind === 'stage') {
      const config = workflow.template.stages.find(
        (s) => s.id === gate.stageId,
      );
      if (
        !config ||
        !('gate' in config) ||
        gate.templateGateId !== config.gate.id ||
        gate.stageKind !== stage.kind ||
        gate.optional !== (config.gate.optional ?? false) ||
        gate.content.type !==
          (
            {
              meeting: 'conclusion',
              planning: 'work-items',
              'final-pr': 'final-pr',
            } as const
          )[gate.stageKind]
      )
        return reject(
          'validation',
          'invalid_stage_gate',
          'Stage gate must match the template',
        );
      if (stage.status !== 'awaiting_gate')
        return reject(
          'conflict',
          'stage_not_complete',
          'Complete the stage before opening its gate',
        );
      if (
        !command.noLiveAttempts ||
        Object.values(state.attempts).some(
          (a) => !a.released && a.state !== 'exited',
        )
      )
        return reject(
          'conflict',
          'live_attempts',
          'All workflow attempts must be exited or released',
        );
      if (
        Object.values(state.gates).some(
          (g) =>
            g.kind === 'stage' && g.stageId === stage.id && g.status === 'open',
        )
      )
        return reject('conflict', 'gate_open', 'Stage gate already open');
    } else {
      if (gate.content.type !== 'exception')
        return reject(
          'validation',
          'invalid_exception_gate',
          'Exception content required',
        );
      const ids = gate.options.map((o) => o.optionId);
      if (new Set(ids).size !== ids.length)
        return reject(
          'validation',
          'invalid_options',
          'Option ids must be unique',
        );
      if (gate.exceptionKind === 'question-escalation') {
        if (!gate.content.questionId || ids.length !== 0)
          return reject(
            'validation',
            'invalid_options',
            'Question gates require a question and text answer',
          );
      } else if (gate.exceptionKind === 'decision-request') {
        if (ids.length < 2 || ids.length > 5 || !ids.includes('abort'))
          return reject(
            'validation',
            'invalid_options',
            'Offer up to four choices plus abort',
          );
      } else if (
        !ids.includes('abort') ||
        ids.length < 2 ||
        ids.some(
          (id) =>
            !(
              EXCEPTION_OPTIONS[
                gate.exceptionKind as keyof typeof EXCEPTION_OPTIONS
              ] as readonly string[]
            ).includes(id),
        )
      )
        return reject(
          'validation',
          'invalid_options',
          'Options do not match the exception kind',
        );
      for (const option of gate.options) {
        const input =
          option.optionId === 'reassign'
            ? 'agent'
            : ['top-up', 'top-up-rerun'].includes(option.optionId)
              ? 'tokens'
              : undefined;
        if (input !== undefined && option.input !== input)
          return reject(
            'validation',
            'invalid_options',
            `Option ${option.optionId} requires ${input} input`,
          );
      }
    }
    const events = [
      draft(
        command.meta,
        { workflowId: workflow.id, stageId: stage.id },
        'gate.opened',
        { ...gate, version: 1 },
      ),
    ];
    if (
      gate.kind === 'stage' &&
      gate.optional &&
      workflow.gateToggles[gate.templateGateId] === false
    )
      events.push(
        draft(
          command.meta,
          { workflowId: workflow.id, stageId: stage.id },
          'gate.decided',
          { gateId: gate.gateId, version: 1, decision: 'approve', by: 'auto' },
        ),
      );
    return accept(...events);
  }
  const gateId =
    command.type === 'UpdateGateContent'
      ? command.update.gateId
      : command.gateId;
  const gate = state.gates[gateId];
  if (!gate) return reject('validation', 'unknown_gate', 'Unknown gate');
  const scope = { workflowId: workflow.id, stageId: gate.stageId };
  if (command.type === 'CloseGate') {
    if (gate.status === 'closed') return accept();
    if (
      command.reason === 'merged' &&
      (gate.kind !== 'stage' ||
        gate.stageKind !== 'final-pr' ||
        gate.content.type !== 'final-pr' ||
        !gate.content.pr ||
        state.prs[String(gate.content.pr)]?.state !== 'merged')
    )
      return reject(
        'conflict',
        'pr_not_merged',
        'Final PR must be observed merged',
      );
    return accept(
      draft(command.meta, scope, 'gate.closed', {
        gateId,
        reason: command.reason,
      }),
    );
  }
  if (gate.status !== 'open')
    return reject('conflict', 'gate_not_open', 'Gate is not open');
  if (command.type === 'UpdateGateContent') {
    if (
      command.update.source === 'github' &&
      gate.content.type !== 'conclusion'
    )
      return reject(
        'validation',
        'not_conclusion',
        'Only conclusion GitHub edits update gate content',
      );
    return accept(
      draft(command.meta, scope, 'gate.content_updated', {
        ...command.update,
        version: gate.version + 1,
      }),
    );
  }
  return decide(state, workflow, gate, command);
};
