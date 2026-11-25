import { describe, expect, it } from 'vitest';
import {
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
} from '@ai-office/contracts/events';
import {
  EVENT_STRING_ALLOWLIST,
  OPAQUE_ID,
  PSEUDONYM,
  exportJointEvents,
  pseudonymizer,
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

describe('opaque local ids (public fixture ruling, M5-T17)', () => {
  // Synthetic ids in the real shapes: Orca run / dispatch / message ids,
  // vendor message ids and UUIDs.
  const run = 'run_a1b2c3d4e5f6';
  const ctx = 'ctx_6bedc4cc570a';
  const ctx2 = 'ctx_0c90a6853ea1';
  const msg = 'msg_862b6965929c';
  const vendorMsg = 'msg_01AbCdEfGhIjKlMnOpQrStUv';
  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const session = '9C4F1D2A-7B3E-4C5D-8E6F-0A1B2C3D4E5F';
  const events = [
    {
      type: 'workflow.started',
      externalKey: `orca:run:${run}`,
      payload: { repo: { orcaRepoId: uuid } },
    },
    {
      type: 'command.issued',
      payload: {
        commandId: `cmd:${msg}`,
        orcaRequestId: session.toLowerCase(),
        args: { session: run, agent: ctx, workspace: { workspace: uuid } },
      },
    },
    {
      type: 'seat.activity',
      externalKey: `orca:tx:${ctx}:${uuid}:seat.activity`,
      payload: { activity: [{ messageId: vendorMsg, text: `see ${ctx2}` }] },
    },
    {
      type: 'seat.status',
      externalKey: `orca:exited:${ctx2}`,
      payload: { attemptId: 'a1', state: 'exited' },
    },
    {
      type: 'submission.accepted',
      externalKey: `orca:msg:${msg}`,
      payload: { agentSession: { provider: 'claude-code', id: session } },
    },
  ];
  const result = exportJointEvents(events, metadata);
  const text = JSON.stringify(result);

  it('leaves none of the ids, and every id-shaped string is a pseudonym', () => {
    for (const id of [run, ctx, ctx2, msg, vendorMsg, uuid, session])
      expect(text.toLowerCase()).not.toContain(id.toLowerCase());
    const found = [...text.matchAll(OPAQUE_ID)].map((m) => m[0]);
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((id) => !PSEUDONYM.test(id))).toEqual([]);
  });

  it('is consistent: equal ids stay equal (case-insensitive UUIDs), distinct ids stay distinct', () => {
    const [started, command, activity, status, accepted] = result.events as {
      externalKey?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test probe
      payload: any;
    }[];
    const repoId = started!.payload.repo.orcaRepoId as string;
    expect(repoId).toBe('00000000-0000-4000-8000-000000000001');
    expect(command!.payload.args.workspace.workspace).toBe(repoId);
    expect(activity!.externalKey).toBe(
      `orca:tx:${command!.payload.args.agent}:${repoId}:seat.activity`,
    );
    expect(started!.externalKey).toBe(
      `orca:run:${command!.payload.args.session}`,
    );
    expect(command!.payload.args.session).toBe('run_000000000001');
    expect(command!.payload.args.agent).toBe('ctx_000000000001');
    expect(status!.externalKey).toBe('orca:exited:ctx_000000000002');
    expect(command!.payload.commandId).toBe('cmd:msg_000000000001');
    expect(accepted!.externalKey).toBe('orca:msg:msg_000000000001');
    expect(accepted!.payload.agentSession.id).toBe(
      command!.payload.orcaRequestId,
    );
    // Paths off the allowlist still become placeholders, hashed after
    // pseudonymizing, so not even the hash links back to the real id.
    expect(activity!.payload.activity[0].messageId).toBe(
      textPlaceholder('msg_' + '2'.padStart(vendorMsg.length - 4, '0')),
    );
    expect(activity!.payload.activity[0].text).toBe(
      textPlaceholder('see ctx_000000000002'),
    );
  });

  it('is deterministic per export and keeps lengths', () => {
    expect(exportJointEvents(events, metadata)).toEqual(result);
    const alias = pseudonymizer();
    for (const id of [run, ctx, vendorMsg, uuid]) {
      expect(alias(id)).toHaveLength(id.length);
      expect(alias(id)).toMatch(PSEUDONYM);
    }
    expect(alias(`x ${run} y`)).toBe(`x ${alias(run)} y`);
    // Not ids: prefixes inside words, and other words with underscores.
    expect(alias('xrun_abc mymsg_1 ctx_ run-1')).toBe(
      'xrun_abc mymsg_1 ctx_ run-1',
    );
  });
});
