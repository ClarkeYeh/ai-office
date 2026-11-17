import type {
  DomainEventDraft,
  EventPayload,
} from '@ai-office/contracts/events';
import type { AnomalyCommand } from '../commands.js';
import { accept, reject } from '../errors.js';
import type { DecideResult } from '../errors.js';
import type { WorkflowState } from '../state/index.js';
import { defined, draft } from './support.js';

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
      if (
        observation.previousSha !== undefined &&
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
  if (found.length > 0 && !workflow.pausedReasons.includes('anomaly'))
    events.push(
      draft(command.meta, scope, 'workflow.paused', { reason: 'anomaly' }),
    );
  return accept(...events);
};
