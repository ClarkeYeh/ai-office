import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION } from '@ai-office/contracts/events';
import type {
  DomainEvent,
  DomainEventDraft,
  EventPayload,
  EventType,
} from '@ai-office/contracts/events';
import { bodyHash, decide, evolve, initialState } from '@ai-office/domain';
import type { WorkflowState } from '@ai-office/domain';
import { markedBody } from '../../adapters/scm-github/methods/marker.js';
import type { ScmEvent } from '../../ports/scm-events.js';
import type { EventStore } from '../../ports/stores.js';
import type { Redactor } from '../../ports/services.js';
import { startWorkflow, WORKFLOW_ID } from '../runner/test-support/harness.js';
import { Batch } from './batch.js';
import { ingestScm } from './scm.js';

// M3-T11 part 2 regression: the conclusion gate's renderedHash must equal the
// hash GitHub reports for the issue the production adapter created, so the
// backend's own label swap is not mistaken for a body edit.
const ISSUE_COMMAND = `${WORKFLOW_ID}/meeting/1/issue`;
const ENGINE_BODY = `# Meeting conclusion\n\nShip it\n\n<!-- ai-office:cmd=${ISSUE_COMMAND} -->`;
const AT = '2026-11-17T00:01:00.000Z';

function draft<T extends EventType>(
  type: T,
  payload: EventPayload<T>,
): DomainEventDraft {
  return {
    type,
    payload,
    workflowId: WORKFLOW_ID,
    occurredAt: AT,
    schemaVersion: CURRENT_SCHEMA_VERSION[type],
    source: 'engine',
    provenance: 'decided',
    stageId: 'meeting',
  } as DomainEventDraft;
}

function world(decided: boolean) {
  const result = decide(initialState(), startWorkflow());
  if (!result.ok) throw new Error(result.error.code);
  const events: DomainEvent[] = [];
  let state: WorkflowState = initialState();
  const apply = (d: DomainEventDraft) => {
    const event = {
      ...d,
      seq: state.lastSeq + 1,
      id: String(state.lastSeq + 1).padStart(26, '0'),
      recordedAt: d.occurredAt,
    } as DomainEvent;
    events.push(event);
    state = evolve(state, event);
  };
  result.events.forEach(apply);
  apply(
    draft('artifact.created', {
      artifactId: ISSUE_COMMAND,
      kind: 'issue',
      purpose: 'conclusion',
      number: 4,
      url: 'https://github.com/octo/demo/issues/4',
    }),
  );
  apply(
    draft('gate.opened', {
      gateId: 'conclusion-gate',
      stageId: 'meeting',
      kind: 'stage',
      stageKind: 'meeting',
      templateGateId: 'conclusion',
      optional: false,
      title: 'Conclusion',
      options: [],
      version: 1,
      // The engine's rule (meeting.ts): bodyHash of the issued body.
      content: {
        type: 'conclusion',
        artifactId: 'conclusion-body',
        renderedHash: bodyHash(ENGINE_BODY),
      },
    }),
  );
  if (decided)
    apply(
      draft('gate.decided', {
        gateId: 'conclusion-gate',
        decision: 'approve',
        by: 'user',
        version: 1,
      }),
    );
  const store = { read: () => events } as unknown as EventStore;
  const batch = new Batch(
    { workflowId: WORKFLOW_ID, state, append: async () => [] },
    store,
  );
  return { batch, store, state };
}

const redactor = { maskSecrets: (labels: string[]) => labels } as Redactor;

describe('conclusion gate hash vs GitHub (label-only edits)', () => {
  it.each([false, true])(
    'a label-only edit yields no UpdateGateContent and no drift (approved=%s)',
    (decided) => {
      const { batch, store, state } = world(decided);
      const repo = state.workflow!.repo.github;
      // Exactly what scm-github sends: the marker is already present.
      const githubBody = markedBody(ENGINE_BODY, ISSUE_COMMAND);
      expect(githubBody).toBe(ENGINE_BODY);
      const edited: ScmEvent = {
        type: 'issue.edited',
        externalKey: 'gh:issue:4:labels',
        occurredAt: AT,
        issue: { repo, number: 4 },
        bodyHash: bodyHash(githubBody),
        updatedAt: AT,
        labels: ['ai-office:conclusion', 'ai-office:approved'],
      };
      ingestScm(batch, [edited], store, redactor);
      expect(batch.drafts).toEqual([]);
    },
  );
  it('a real body edit still updates the open gate', () => {
    const { batch, store, state } = world(false);
    ingestScm(
      batch,
      [
        {
          type: 'issue.edited',
          externalKey: 'gh:issue:4:body',
          occurredAt: AT,
          issue: { repo: state.workflow!.repo.github, number: 4 },
          bodyHash: bodyHash('Edited on GitHub'),
          updatedAt: AT,
          labels: ['ai-office:conclusion'],
        },
      ],
      store,
      redactor,
    );
    expect(batch.drafts.map((d) => d.type)).toEqual(['gate.content_updated']);
  });
});
