import type {
  CommandResult,
  DomainEventDraft,
  EventPayload,
} from '@ai-office/contracts/events';
import type { AnomalyCommand } from '../commands.js';
import { accept, reject } from '../errors.js';
import type { DecideResult } from '../errors.js';
import type { CommandRecord, WorkflowState } from '../state/index.js';
import { defined, draft } from './support.js';

type ResultOf<K extends CommandResult['kind']> = Extract<
  CommandResult,
  { kind: K }
>['result'];

/** The recorded result of a succeeded command of `kind`. */
const resultOf = <K extends CommandResult['kind']>(
  record: CommandRecord | undefined,
  kind: K,
): ResultOf<K> | undefined => {
  const result: unknown =
    record?.result?.kind === kind ? record.result.result : undefined;
  return result as ResultOf<K> | undefined;
};

/** GitHub comment ids are numeric strings; compare them as numbers. */
const lowerId = (a: string, b: string): string =>
  /^\d+$/.test(a) && /^\d+$/.test(b)
    ? a.length !== b.length
      ? a.length < b.length
        ? a
        : b
      : a < b
        ? a
        : b
    : a < b
      ? a
      : b;

/**
 * A merge commit we know of: a recorded `scm.mergePR` result (any command,
 * including a human-chosen merge), a merged work item, or an observed merged
 * PR. Such a head never counts as an outside move of the integration branch.
 */
const knownMergeResult = (state: WorkflowState, sha: string): boolean =>
  Object.values(state.commands).some(
    (record) => resultOf(record, 'scm.mergePR')?.mergeCommitSha === sha,
  ) ||
  Object.values(state.workItems).some((item) => item.mergeCommitSha === sha) ||
  Object.values(state.prs).some(
    (pr) => pr.state === 'merged' && pr.mergeCommitSha === sha,
  );

/** Worker PRs: opened by one of this workflow's commands, other than the final PR. */
const isWorkerPr = (state: WorkflowState, pr: number): boolean =>
  pr !== state.workflow?.finalPr &&
  (Object.values(state.workItems).some((item) => item.pr === pr) ||
    Object.values(state.commands).some(
      (record) => resultOf(record, 'scm.openPR')?.pr === pr,
    ));

/** S9: the backend closed the PR itself, or deleted its head branch. */
const closedByBackend = (
  state: WorkflowState,
  pr: EventPayload<'pr.status'>,
): boolean =>
  Object.values(state.commands).some(
    ({ issued }) =>
      (issued.kind === 'scm.updatePR' &&
        issued.args.pr.number === pr.pr &&
        issued.args.patch.state === 'closed') ||
      (issued.kind === 'scm.deleteBranch' && issued.args.name === pr.head),
  );

/**
 * S19 (M3 §4.8): one `duplicate-object` anomaly per extra copy, never for the
 * kept one. The kept copy is the one the command's `command.succeeded`
 * recorded; without a result, the lowest number. `scm.comment` results carry
 * no comment id, so for comments the lowest id is always kept. Copies already
 * reported are skipped, so repeated polls and replays stay idempotent.
 */
const duplicates = (
  state: WorkflowState,
  observation: Extract<AnomalyCommand['observation'], { kind: 'duplicate' }>,
): EventPayload<'anomaly.detected'>[] => {
  const record = state.commands[observation.commandId];
  if (!record) return []; // another run's marker: never compensate it
  const issued = record.issued;
  const reported = new Set(
    state.anomalies
      .filter(
        (a) =>
          a.kind === 'duplicate-object' &&
          a.commandId === observation.commandId,
      )
      .map((a) => a.commentId ?? String(a.number)),
  );
  const anomaly = {
    kind: 'duplicate-object' as const,
    severity: 'warning' as const,
    commandId: observation.commandId,
  };
  if (observation.objectKind === 'comment') {
    if (issued.kind !== 'scm.comment') return [];
    const target = observation.target;
    if (
      target !== undefined &&
      (target.number !== issued.args.target.number ||
        target.repo.owner !== issued.args.target.repo.owner ||
        target.repo.name !== issued.args.target.repo.name)
    )
      return [];
    const ids = [...new Set(observation.commentIds ?? [])];
    if (ids.length < 2) return [];
    const keep = ids.reduce(lowerId);
    return ids
      .filter((commentId) => commentId !== keep && !reported.has(commentId))
      .map((commentId) => ({
        ...anomaly,
        summary: 'Duplicate marker comment deleted',
        commentId,
      }));
  }
  const recorded =
    observation.objectKind === 'issue'
      ? issued.kind === 'scm.createIssue'
        ? (resultOf(record, 'scm.createIssue')?.issue ?? null)
        : undefined
      : issued.kind === 'scm.openPR'
        ? (resultOf(record, 'scm.openPR')?.pr ?? null)
        : undefined;
  if (recorded === undefined) return [];
  const numbers = [...new Set(observation.numbers ?? [])];
  if (numbers.length < 2) return [];
  const keep = recorded ?? Math.min(...numbers);
  return numbers
    .filter((number) => number !== keep && !reported.has(String(number)))
    .map((number) => ({
      ...anomaly,
      summary: `Duplicate marker ${observation.objectKind} closed`,
      number,
    }));
};

export const decideAnomaly = (
  state: WorkflowState,
  command: AnomalyCommand,
): DecideResult => {
  const workflow = state.workflow;
  if (workflow === null)
    return reject(
      'conflict',
      'workflow_not_started',
      'Workflow has not started',
    );
  if (workflow.status !== 'running') return accept();
  const observation = command.observation;
  const found: EventPayload<'anomaly.detected'>[] = [];
  const events: DomainEventDraft[] = [];
  const scope = { workflowId: workflow.id };
  switch (observation.kind) {
    case 'issue':
    case 'pr': {
      const number =
        observation.kind === 'issue' ? observation.number : observation.pr.pr;
      if (
        !observation.managed &&
        observation.author === workflow.repo.ownerLogin &&
        observation.createdAt !== undefined &&
        Date.parse(observation.createdAt) >= Date.parse(workflow.startedAt)
      )
        found.push({
          kind: 'unknown-object',
          severity: 'medium',
          summary: `Unmarked ${observation.kind} created by repository owner`,
          number,
          ...defined({ author: observation.author }),
        });
      if (
        observation.kind === 'pr' &&
        observation.pr.state === 'closed' &&
        isWorkerPr(state, observation.pr.pr) &&
        !closedByBackend(state, observation.pr) &&
        !state.anomalies.some(
          (a) => a.kind === 'unmanaged-close' && a.number === observation.pr.pr,
        )
      )
        found.push({
          kind: 'unmanaged-close',
          severity: 'warning',
          summary: 'Worker PR closed without a backend command',
          number: observation.pr.pr,
        });
      if (observation.kind === 'pr' && observation.pr.state === 'merged') {
        const pr = observation.pr;
        if (
          pr.base === workflow.integrationBranch &&
          !Object.values(state.commands).some(
            ({ issued }) =>
              issued.kind === 'scm.mergePR' &&
              issued.args.pr.number === pr.pr &&
              issued.args.pr.repo.owner === workflow.repo.github.owner &&
              issued.args.pr.repo.name === workflow.repo.github.name &&
              issued.args.expectedHeadSha === pr.headSha,
          )
        )
          found.push({
            kind: 'unmanaged-merge',
            severity: 'high',
            summary: 'Worker PR merged without matching backend command',
            number: pr.pr,
          });
        if (
          pr.pr === workflow.finalPr &&
          !Object.values(state.submissions).some(
            (s) => s.kind === 'integration-report',
          )
        )
          found.push({
            kind: 'early-merge',
            severity: 'high',
            summary: 'Final PR merged before acceptance of integration report',
            number: pr.pr,
          });
      }
      break;
    }
    case 'default-branch': {
      const final =
        workflow.finalPr === undefined
          ? undefined
          : state.prs[workflow.finalPr];
      // No previous head is the first observation (baseline), never a move.
      if (
        observation.previousSha !== undefined &&
        observation.previousSha !== null &&
        observation.sha !== observation.previousSha &&
        !(final?.state === 'merged' && final.mergeCommitSha === observation.sha)
      )
        found.push({
          kind: 'default-branch-moved',
          severity: 'warning',
          summary: 'Default branch changed outside the final PR merge',
          sha: observation.sha,
        });
      break;
    }
    case 'integration-branch': {
      // S14: during implement only backend merges move the integration
      // branch; the wrap-up's fix-forward pushes are allowed.
      if (
        observation.previousSha !== null &&
        observation.sha !== observation.previousSha &&
        Object.values(state.stages).some(
          (s) => s.kind === 'implement' && s.status === 'running',
        ) &&
        !knownMergeResult(state, observation.sha) &&
        !state.anomalies.some(
          (a) =>
            a.kind === 'integration-branch-moved' && a.sha === observation.sha,
        )
      )
        found.push({
          kind: 'integration-branch-moved',
          severity: 'warning',
          summary: 'Integration branch moved outside a backend merge',
          sha: observation.sha,
        });
      break;
    }
    case 'duplicate':
      found.push(...duplicates(state, observation));
      break;
    case 'merge-base-changed':
      if (
        state.commands[observation.commandId]?.issued.kind === 'scm.mergePR' &&
        !state.anomalies.some(
          (a) =>
            a.kind === 'merge-base-changed' &&
            a.commandId === observation.commandId,
        )
      )
        found.push({
          kind: 'merge-base-changed',
          severity: 'high',
          summary: 'Worker PR base changed while merging',
          number: observation.pr,
          commandId: observation.commandId,
        });
      break;
    case 'policy-hits':
      if (state.attempts[observation.attemptId] === undefined)
        return reject(
          'validation',
          'unknown_attempt',
          'Policy observation requires an attempt',
        );
      if (observation.hits.length > 0) {
        events.push(
          draft(
            command.meta,
            { ...scope, attemptId: observation.attemptId },
            'seat.policy_violation',
            { attemptId: observation.attemptId, hits: observation.hits },
          ),
        );
        found.push({
          kind: 'policy-hit',
          severity: observation.hits.some((hit) => hit.severity === 'high')
            ? 'high'
            : 'medium',
          summary: 'Agent policy violation',
          attemptId: observation.attemptId,
        });
      }
      break;
    case 'unmanaged-agent':
      if (
        !state.unmanagedAgents.some(
          (agent) => agent.dispatch === observation.agent.dispatch,
        )
      ) {
        events.push(
          draft(command.meta, scope, 'agent.unmanaged', observation.agent),
        );
        found.push({
          kind: 'policy-hit',
          severity: 'high',
          summary: 'Unmanaged agent observed',
          dispatch: observation.agent.dispatch,
        });
      }
      break;
  }
  for (const anomaly of found)
    events.push(draft(command.meta, scope, 'anomaly.detected', anomaly));
  // SPEC rev2.15.3 §12.3: warning-level anomalies are notifications only.
  if (
    found.some((anomaly) => anomaly.severity !== 'warning') &&
    !workflow.pausedReasons.includes('anomaly')
  )
    events.push(
      draft(command.meta, scope, 'workflow.paused', { reason: 'anomaly' }),
    );
  return accept(...events);
};
