import type { EventPayload } from '@ai-office/contracts/events';
import type { ScmEvent } from '../../ports/scm-events.js';
import type { EventStore } from '../../ports/stores.js';
import type { Redactor } from '../../ports/services.js';
import { Batch } from './batch.js';

export function ingestScm(
  batch: Batch,
  events: readonly ScmEvent[],
  store: EventStore,
  redactor: Redactor,
): void {
  const workflow = batch.state.workflow!;
  const history = store.read({ workflowId: workflow.id });
  const matches = (repo: { owner: string; name: string }) =>
    repo.owner === workflow.repo.github.owner &&
    repo.name === workflow.repo.github.name;
  for (const event of events) {
    if (batch.observed(event.externalKey)) continue;
    switch (event.type) {
      case 'pr.state': {
        if (!matches(event.pr.repo)) continue;
        const old = batch.state.prs[event.pr.number];
        const payload: EventPayload<'pr.status'> = {
          pr: event.pr.number,
          state: event.state,
          base: event.base,
          head: event.head,
          headSha: event.headSha,
          mergeable: event.mergeable,
          ...(old?.checks === undefined ? {} : { checks: old.checks }),
          ...(event.mergedBy === undefined ? {} : { mergedBy: event.mergedBy }),
          ...(event.mergeCommitSha === undefined
            ? {}
            : { mergeCommitSha: event.mergeCommitSha }),
        };
        batch.add('pr.status', payload, event, 'scm');
        batch.anomaly({ kind: 'pr', pr: payload, managed: true }, event, 'scm');
        break;
      }
      case 'pr.checks': {
        if (!matches(event.pr.repo)) continue;
        let pr = batch.state.prs[event.pr.number];
        if (!pr) {
          // Some providers deliver checks before the state in the same poll.
          const state = events.find(
            (e) =>
              e.type === 'pr.state' &&
              e.pr.number === event.pr.number &&
              matches(e.pr.repo),
          );
          if (state?.type === 'pr.state')
            pr = {
              pr: state.pr.number,
              state: state.state,
              base: state.base,
              head: state.head,
              headSha: state.headSha,
              mergeable: state.mergeable,
              ...(state.mergeCommitSha === undefined
                ? {}
                : { mergeCommitSha: state.mergeCommitSha }),
            };
        }
        if (!pr) throw new Error('PR checks have no observed PR state');
        batch.add('pr.status', { ...pr, checks: event.status }, event, 'scm');
        break;
      }
      case 'issue.edited': {
        if (!matches(event.issue.repo)) continue;
        const artifactEvent = history.findLast(
          (e) =>
            e.type === 'artifact.created' &&
            e.payload.kind === 'issue' &&
            e.payload.number === event.issue.number,
        );
        const artifact =
          artifactEvent?.type === 'artifact.created' &&
          artifactEvent.payload.kind === 'issue'
            ? artifactEvent.payload
            : undefined;
        if (!artifact) continue;
        const gate =
          artifact.purpose === 'conclusion'
            ? Object.values(batch.state.gates).findLast(
                (g) =>
                  g.content.type === 'conclusion' &&
                  g.stageId === artifactEvent?.stageId,
              )
            : undefined;
        if (gate?.status === 'open' && gate.content.type === 'conclusion') {
          const hash = gate.github?.bodyHash ?? gate.content.renderedHash;
          if (hash !== event.bodyHash)
            batch.command(
              {
                type: 'UpdateGateContent',
                meta: {
                  occurredAt: event.occurredAt,
                  source: 'scm',
                  provenance: 'observed',
                },
                update: {
                  gateId: gate.gateId,
                  source: 'github',
                  bodyHash: event.bodyHash,
                  githubUpdatedAt: event.updatedAt,
                },
              },
              event,
            );
        } else {
          // §8.2: only body edits drift; label and comment changes (including
          // the backend's own decision labels) keep the last known body hash.
          const known =
            batch.state.issueDrift[event.issue.number]?.bodyHash ??
            (gate?.content.type === 'conclusion'
              ? (gate.github?.bodyHash ?? gate.content.renderedHash)
              : undefined);
          if (known === event.bodyHash) break;
          batch.add(
            'scm.issue_drift',
            {
              issue: event.issue.number,
              bodyHash: event.bodyHash,
              githubUpdatedAt: event.updatedAt,
              labels: redactor.maskSecrets(event.labels),
              ...(artifact.itemKey === undefined
                ? {}
                : { itemKey: artifact.itemKey }),
              ...(gate === undefined ? {} : { gateId: gate.gateId }),
            },
            event,
            'scm',
          );
        }
        break;
      }
      case 'repo.object_created':
        if (matches(event.ref.repo))
          batch.anomaly(
            {
              kind: 'issue',
              number: event.ref.number,
              author: event.author,
              managed: event.hasMarker,
              createdAt: event.occurredAt,
            },
            event,
            'scm',
          );
        break;
    }
  }
}
