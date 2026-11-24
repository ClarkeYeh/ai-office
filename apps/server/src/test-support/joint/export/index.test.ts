import { describe, expect, it } from 'vitest';
import {
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
} from '@ai-office/contracts/events';
import {
  EVENT_STRING_ALLOWLIST,
  exportJointEvents,
  textPlaceholder,
} from './index.js';
const metadata = {
  exportedAt: '2026-11-24T00:00:00Z',
  aiOfficeCommit: 'a'.repeat(40),
  orcaVersion: '1.4.272',
};
describe('public joint export', () => {
  it('covers every event type and replaces unknown strings at every depth', () => {
    expect(Object.keys(EVENT_STRING_ALLOWLIST)).toEqual([...EVENT_TYPES]);
    const events = [
      {
        type: 'message.question',
        id: 'event-1',
        seq: 1,
        occurredAt: '2026-11-24T00:00:00Z',
        payload: {
          questionId: 'q1',
          body: 'Private question',
          unknown: { id: 'Private nested ID' },
          tokens: 42,
          ready: true,
        },
      },
      {
        type: 'future.event',
        payload: { id: 'unknown-id' },
        occurredAt: '2026-11-24T00:00:01Z',
      },
    ];
    const result = exportJointEvents(events, metadata);
    expect(result.events[0]).toMatchObject({
      type: 'message.question',
      id: 'event-1',
      occurredAt: '2000-01-01T00:00:00.000Z',
      payload: {
        questionId: 'q1',
        body: textPlaceholder('Private question'),
        unknown: { id: textPlaceholder('Private nested ID') },
        tokens: 42,
        ready: true,
      },
    });
    expect(result.events[1]).toMatchObject({
      type: textPlaceholder('future.event'),
      occurredAt: '2000-01-01T00:00:01.000Z',
      payload: { id: textPlaceholder('unknown-id') },
    });
    expect(events[0]?.payload.body).toBe('Private question');
  });
  it('preserves only caller-reviewed requirements and rejects secrets in structural fields', () => {
    const requirement = 'Build a tiny calculator.';
    const event = {
      type: 'workflow.started',
      payload: { requirement },
      externalKey: 'aio_ctl_synthetic_secret',
    };
    expect(exportJointEvents([event], metadata).events[0]).toMatchObject({
      payload: { requirement: textPlaceholder(requirement) },
      externalKey: textPlaceholder('aio_ctl_synthetic_secret'),
    });
    expect(
      exportJointEvents([event], { ...metadata, requirements: [requirement] })
        .events[0],
    ).toMatchObject({ payload: { requirement } });
  });
  it('never treats a known field from another event as approved', () => {
    expect(
      exportJointEvents(
        [{ type: 'meeting.statement', payload: { status: 'private' } }],
        metadata,
      ).events[0],
    ).toMatchObject({ payload: { status: textPlaceholder('private') } });
  });
});

it('retains template structure for budget replay without retaining role prose', () => {
  const event = {
    type: 'workflow.started',
    payload: {
      shortId: 'abc123',
      integrationBranch: 'ai-office/abc123-calc',
      templateSnapshot: {
        apiVersion: 'ai-office/v1alpha1',
        roles: {
          lead: { agent: 'claude-code', scope: 'Private instructions' },
        },
        stages: [
          {
            id: 'meeting',
            kind: 'meeting',
            facilitator: 'lead',
            participants: ['lead'],
            budget: { tokens: 1000 },
          },
        ],
      },
    },
  };
  expect(exportJointEvents([event], metadata).events[0]).toMatchObject({
    payload: {
      shortId: 'abc123',
      templateSnapshot: {
        apiVersion: 'ai-office/v1alpha1',
        roles: {
          lead: {
            agent: 'claude-code',
            scope: textPlaceholder('Private instructions'),
          },
        },
        stages: [
          {
            id: 'meeting',
            kind: 'meeting',
            facilitator: 'lead',
            participants: ['lead'],
            budget: { tokens: 1000 },
          },
        ],
      },
    },
  });
});

/** Does a dotted payload path (`*` for array items and record values) exist in a zod schema? */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- walks zod internals
function schemaHas(schema: any, parts: readonly string[]): boolean {
  const def = schema._zod.def;
  if (
    ['optional', 'nullable', 'default', 'readonly', 'catch'].includes(def.type)
  )
    return schemaHas(def.innerType, parts);
  if (def.type === 'pipe') return schemaHas(def.in, parts);
  if (def.type === 'lazy') return schemaHas(def.getter(), parts);
  if (def.type === 'union')
    return def.options.some((option: unknown) => schemaHas(option, parts));
  if (def.type === 'intersection')
    return schemaHas(def.left, parts) || schemaHas(def.right, parts);
  if (parts.length === 0) return true;
  const [head, ...rest] = parts;
  if (def.type === 'object')
    return Object.hasOwn(def.shape, head!) && schemaHas(def.shape[head!], rest);
  if (def.type === 'array') return head === '*' && schemaHas(def.element, rest);
  if (def.type === 'record')
    return head === '*' && schemaHas(def.valueType, rest);
  return false;
}

it('allowlists only payload paths that exist in the contracts schemas', () => {
  const missing = EVENT_TYPES.flatMap((type) =>
    EVENT_STRING_ALLOWLIST[type]
      .filter((path) => path.startsWith('payload.'))
      .filter(
        (path) =>
          !schemaHas(EVENT_PAYLOAD_SCHEMAS[type], path.slice(8).split('.')),
      )
      .map((path) => `${type} ${path}`),
  );
  expect(missing).toEqual([]);
});

it('keeps work-item dependency keys and still placeholders unknown fields', () => {
  const items = [
    { key: 'core', agent: 'claude-code', deps: [], title: 'Private title' },
    { key: 'mul', agent: 'codex', deps: ['core'], dependsOn: ['core'] },
  ];
  const [proposed, approved] = exportJointEvents(
    [
      { type: 'workitem.proposed', payload: { stageId: 'breakdown', items } },
      { type: 'workitem.approved', payload: { gateId: 'g1', items } },
    ],
    metadata,
  ).events;
  for (const event of [proposed, approved])
    expect(event).toMatchObject({
      payload: {
        items: [
          {
            key: 'core',
            agent: 'claude-code',
            deps: [],
            title: textPlaceholder('Private title'),
          },
          {
            key: 'mul',
            agent: 'codex',
            deps: ['core'],
            dependsOn: [textPlaceholder('core')],
          },
        ],
      },
    });
});
