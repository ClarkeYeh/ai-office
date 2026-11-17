import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  DomainEventSchema,
  ConclusionSchema,
  WorkItemDraftSchema,
} from './events/index.js';
import { WorkflowTemplateSchema } from './template/index.js';
import {
  AgentSubmissionSchema,
  CLI_EXIT_CODES,
} from './agent-submission/index.js';
import { apiEndpoints, StartWorkflowRequestSchema } from './api/index.js';
import { StreamMessageSchema } from './stream/index.js';

const template = () =>
  parse(
    readFileSync(
      new URL('../../templates/feature-to-pr.yaml', import.meta.url),
      'utf8',
    ),
  );
const roundTrip = (schema: z.ZodType, value: unknown) => {
  const parsed = schema.parse(value);
  expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(value);
};
const envelope = {
  seq: 1,
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  occurredAt: '2026-11-17T00:00:00Z',
  recordedAt: '2026-11-17T00:00:01Z',
  workflowId: null,
  source: 'system',
  provenance: 'observed',
  schemaVersion: 1,
};
test('all 63 domain event variants round-trip and reject runtime-only events', () => {
  expect(DomainEventSchema.options).toHaveLength(63);
  for (const option of DomainEventSchema.options)
    roundTrip(DomainEventSchema, {
      ...envelope,
      type: option.shape.type.value,
      payload: { futureField: true },
    });
  expect(
    DomainEventSchema.safeParse({
      ...envelope,
      type: 'agent.output',
      payload: {},
    }).success,
  ).toBe(false);
  expect(
    DomainEventSchema.safeParse({
      ...envelope,
      seq: -1,
      type: 'workflow.started',
      payload: {},
    }).success,
  ).toBe(false);
});
test('built-in feature-to-pr template round-trips', () =>
  roundTrip(WorkflowTemplateSchema, template()));
const invalidTemplates: [
  string,
  (value: ReturnType<typeof template>) => void,
][] = [
  [
    'facilitator reference',
    (t) => {
      t.stages[0].facilitator = 'missing';
    },
  ],
  [
    'participant reference',
    (t) => {
      t.stages[0].participants.push('missing');
    },
  ],
  [
    'owner reference',
    (t) => {
      t.stages[1].owner = 'missing';
    },
  ],
  [
    'implement role reference',
    (t) => {
      t.stages[2].role = 'missing';
    },
  ],
  [
    'on-call role reference',
    (t) => {
      t.stages[2].onCall.role = 'missing';
    },
  ],
  [
    'upstream reference',
    (t) => {
      t.stages[1].from = 'integrate';
    },
  ],
  [
    'missing stage reference',
    (t) => {
      t.stages[1].from = 'missing';
    },
  ],
  [
    'unique stage ids',
    (t) => {
      t.stages[1].id = 'meeting';
    },
  ],
  [
    'unique gate ids',
    (t) => {
      t.stages[1].gate.id = 'conclusion';
    },
  ],
  [
    'kind ordering',
    (t) => {
      [t.stages[2], t.stages[3]] = [t.stages[3], t.stages[2]];
    },
  ],
  [
    'final-pr is last',
    (t) => {
      [t.stages[3], t.stages[4]] = [t.stages[4], t.stages[3]];
    },
  ],
  [
    'final-pr required',
    (t) => {
      t.stages.pop();
    },
  ],
  [
    'final-pr optional true',
    (t) => {
      t.stages[4].gate.optional = true;
    },
  ],
  [
    'final-pr optional false',
    (t) => {
      t.stages[4].gate.optional = false;
    },
  ],
  [
    'unsupported decision kind',
    (t) => {
      t.stages[1].kind = 'decision';
    },
  ],
];
test.each(invalidTemplates)('rejects invalid template: %s', (_, mutate) => {
  const value = template();
  mutate(value);
  expect(WorkflowTemplateSchema.safeParse(value).success).toBe(false);
});
const submissions = [
  {
    kind: 'agenda',
    payload: {
      topics: [{ id: 'topic', title: 'Plan', focusByRole: { lead: 'Scope' } }],
    },
  },
  {
    kind: 'statement',
    payload: {
      round: 1,
      position: 'Agree',
      arguments: [],
      concerns: [],
      readyToConclude: true,
    },
  },
  {
    kind: 'conclusion',
    payload: {
      summary: 'Build it',
      decisions: [],
      techDecisions: [],
      openQuestions: [],
    },
  },
  {
    kind: 'work-items',
    payload: {
      items: [
        {
          key: 'w1',
          title: 'Build',
          body: '',
          acceptance: [],
          role: 'engineer',
          deps: [],
        },
      ],
    },
  },
  { kind: 'answer-question', payload: { questionId: 'q1', body: 'Yes' } },
  { kind: 'merge-request', payload: { pr: 1, expectedHeadSha: 'abc' } },
  {
    kind: 'decision-request',
    payload: { reason: 'other', question: 'Which?', options: ['A'] },
  },
  {
    kind: 'integration-report',
    payload: {
      summary: 'Done',
      merged: [1],
      verification: [{ command: 'pnpm test', ok: true }],
      risks: [],
    },
  },
];
test.each(submissions)('submission $kind round-trips', (value) =>
  roundTrip(AgentSubmissionSchema, value),
);
test('submission discriminant and CLI codes are fixed', () => {
  expect(
    AgentSubmissionSchema.safeParse({ kind: 'agenda', payload: { pr: 1 } })
      .success,
  ).toBe(false);
  expect(CLI_EXIT_CODES).toEqual({
    SUCCESS: 0,
    SCHEMA_ERROR: 2,
    IDENTITY_OR_STATE_ERROR: 3,
    BACKEND_UNREACHABLE: 4,
  });
});
test('API start request round-trips and requires input', () => {
  roundTrip(StartWorkflowRequestSchema, {
    templateId: 'feature-to-pr',
    repoId: 'r1',
    requirement: 'Build',
  });
  expect(StartWorkflowRequestSchema.safeParse({}).success).toBe(false);
  expect(apiEndpoints).toHaveLength(22);
  expect(new Set(apiEndpoints.map((e) => e.operationId)).size).toBe(22);
});
test('SSE data, resync, and comment frames round-trip', () => {
  for (const value of [
    {
      event: 'domain',
      id: '1',
      data: { ...envelope, type: 'health.changed', payload: {} },
    },
    { event: 'resync_required' },
    { event: 'keepalive', comment: 'keepalive' },
  ])
    roundTrip(StreamMessageSchema, value);
  expect(StreamMessageSchema.safeParse({ event: 'unknown' }).success).toBe(
    false,
  );
});
test('package exposes only the five allowed subpaths', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  expect(Object.keys(pkg.exports).sort()).toEqual([
    './agent-submission',
    './api',
    './events',
    './stream',
    './template',
  ]);
  expect(Object.keys(pkg.dependencies)).toEqual(['zod']);
});

test('template roles preserve optional free-text scope', () => {
  const value = WorkflowTemplateSchema.parse(template());
  for (const role of Object.values(value.roles))
    expect(role.scope?.length).toBeGreaterThan(0);
  const withoutScopes = template();
  for (const role of Object.values(withoutScopes.roles) as { scope?: string }[])
    delete role.scope;
  expect(WorkflowTemplateSchema.safeParse(withoutScopes).success).toBe(true);
});

test('template role scope is limited to 1000 characters', () => {
  const withScope = (scope: string) => {
    const value = template();
    (value.roles as Record<string, { scope?: string }>).pm!.scope = scope;
    return WorkflowTemplateSchema.safeParse(value).success;
  };
  expect(withScope('x'.repeat(1000))).toBe(true);
  expect(withScope('x'.repeat(1001))).toBe(false);
});

test('submissions reuse the shared event payload schemas', () => {
  const conclusion = AgentSubmissionSchema.options.find(
    (option) => option.shape.kind.value === 'conclusion',
  );
  const workItems = AgentSubmissionSchema.options.find(
    (option) => option.shape.kind.value === 'work-items',
  );
  expect(conclusion?.shape.payload).toBe(ConclusionSchema);
  if (!workItems || !('items' in workItems.shape.payload.shape)) {
    throw new Error('Expected a work-items submission payload');
  }
  expect(workItems.shape.payload.shape.items.element).toBe(WorkItemDraftSchema);
});

test.each(['meeting', 'planning', 'implement', 'integrate', 'final-pr'])(
  'requires stage kind %s exactly once',
  (kind) => {
    const missing = WorkflowTemplateSchema.parse(template());
    missing.stages = missing.stages.filter((stage) => stage.kind !== kind);
    expect(WorkflowTemplateSchema.safeParse(missing).success).toBe(false);
    const duplicate = WorkflowTemplateSchema.parse(template());
    const index = duplicate.stages.findIndex((stage) => stage.kind === kind);
    duplicate.stages.splice(
      index,
      0,
      structuredClone(duplicate.stages[index]!),
    );
    expect(WorkflowTemplateSchema.safeParse(duplicate).success).toBe(false);
  },
);

test('rejects the previously accepted meeting → integrate → final-pr subset', () => {
  const value = WorkflowTemplateSchema.parse(template());
  value.stages = value.stages.filter(
    (stage) => !['planning', 'implement'].includes(stage.kind),
  );
  const result = WorkflowTemplateSchema.safeParse(value);
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ['stages'],
        message: 'All five stage kinds are required, each exactly once',
      }),
    );
});
