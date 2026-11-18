import { describe, expect, it } from 'vitest';
import { RuntimeEventSchema, ScmEventSchema, PortError } from './index.js';
const envelope = {
  externalKey: 'external:1',
  occurredAt: '2026-01-01T00:00:00.000Z',
};
describe('port event schemas', () => {
  const variants = [
    { type: 'agent.status', agent: 'a', state: 'waiting_input' },
    {
      type: 'agent.output',
      agent: 'a',
      messageId: 'm',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'example' },
        {
          type: 'tool_use',
          id: 't',
          name: 'read',
          input: { path: 'example.ts' },
        },
        { type: 'tool_result', toolUseId: 't', output: 'example', ok: true },
      ],
    },
    { type: 'agent.question', agent: 'a', question: 'q', body: 'question' },
    { type: 'agent.done', agent: 'a', outcome: 'success', filesModified: 1 },
    { type: 'agent.exited', agent: 'a', reason: 'finished' },
    { type: 'agent.stopped', agent: 'a' },
    { type: 'agent.degraded', agent: 'a', reason: 'source_changed' },
    { type: 'agent.unmanaged', dispatch: 'dispatch' },
    { type: 'runtime.identity_restored', newShim: 'shim', runs: ['run'] },
    {
      type: 'runtime.identity_hijacked',
      run: 'run',
      coordinatorHandle: 'shim',
      consumerGeneration: 1,
    },
    {
      type: 'runtime.contract_mismatch',
      command: 'observe',
      issues: ['shape'],
    },
  ];
  it.each(variants)(
    'validates $type with required dedup and time metadata',
    (variant) => {
      expect(
        RuntimeEventSchema.safeParse({ ...envelope, ...variant }).success,
      ).toBe(true);
      expect(RuntimeEventSchema.safeParse(variant).success).toBe(false);
      expect(
        RuntimeEventSchema.safeParse({
          ...envelope,
          ...variant,
          occurredAt: 'bad',
        }).success,
      ).toBe(false);
    },
  );
  it('rejects invalid states, outcomes, counts and raw blocks', () => {
    for (const value of [
      { type: 'agent.status', agent: 'a', state: 'stopped' },
      { type: 'agent.done', agent: 'a', outcome: 'unknown' },
      { type: 'agent.done', agent: 'a', outcome: 'success', filesModified: -1 },
      {
        type: 'agent.output',
        agent: 'a',
        messageId: 'm',
        role: 'assistant',
        blocks: [{ type: 'unknown' }],
      },
    ])
      expect(
        RuntimeEventSchema.safeParse({ ...envelope, ...value }).success,
      ).toBe(false);
  });
  const ref = { repo: { owner: 'example', name: 'repo' }, number: 1 };
  it.each([
    {
      type: 'pr.state',
      pr: ref,
      state: 'merged',
      base: 'main',
      head: 'feature',
      headSha: 'abc',
      mergeable: null,
    },
    { type: 'pr.checks', pr: ref, status: 'success' },
    {
      type: 'issue.edited',
      issue: ref,
      bodyHash: 'hash',
      updatedAt: envelope.occurredAt,
      labels: [],
    },
    { type: 'repo.object_created', ref, author: 'example', hasMarker: true },
  ])('validates $type SCM observations', (variant) => {
    expect(ScmEventSchema.safeParse({ ...envelope, ...variant }).success).toBe(
      true,
    );
    expect(ScmEventSchema.safeParse(variant).success).toBe(false);
  });
  it('carries the error category and explicit retryability', () => {
    const error = new PortError(
      'guard',
      'unsafe_merge',
      'Default branch refused',
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.category).toBe('guard');
    expect(error.retryable).toBe(false);
  });
});
