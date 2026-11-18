import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimePort } from '../ports/runtime.js';
import type { AgentRef, SessionRef } from '../ports/refs.js';
import { RuntimeEventSchema } from '../ports/runtime-events.js';

/** A fake or fixture-replay adapter supplies stimuli; all assertions use only RuntimePort. */
export type RuntimeContractFixture = {
  runtime: RuntimePort;
  session: SessionRef;
  prepareRequest: Parameters<RuntimePort['prepareWorkspace']>[0] & {
    baseSha: string;
  };
  /** Existing remote worker branch, pinned to its comparison head, with a -r1 name. */
  reworkRequest: Parameters<RuntimePort['prepareWorkspace']>[0] & {
    checkoutExisting: true;
  };
  spawnRequest: Parameters<RuntimePort['spawnAgent']>[0];
  advance(ms: number): void | Promise<void>;
  stimulus(
    agent: AgentRef,
    action: 'done' | 'ask-with-false-escalation' | 'turn-start-unobserved',
  ): void | Promise<void>;
  identity(agent: AgentRef): { terminalHandle: string; paneKey?: string };
  dispose?(): void | Promise<void>;
};
export function runtimePortContract(
  factory: () => RuntimeContractFixture | Promise<RuntimeContractFixture>,
): void {
  describe('RuntimePort contract', () => {
    let f: RuntimeContractFixture;
    beforeEach(async () => {
      f = await factory();
    });
    afterEach(async () => {
      await f.dispose?.();
    });
    it('explicitly reclaims a session idempotently without a request ID', async () => {
      expect(await f.runtime.reclaimSession(f.session)).toEqual({
        reclaimed: true,
      });
      expect(await f.runtime.reclaimSession(f.session)).toEqual({
        reclaimed: true,
      });
    });
    it('returns the pinned base and a usable workspace path, with stable replay', async () => {
      const prepared = await f.runtime.prepareWorkspace(f.prepareRequest);
      expect(prepared.baseSha).toBe(f.prepareRequest.baseSha);
      expect(prepared.path).toMatch(/^\//);
      expect(prepared.workspace).toBeTruthy();
      expect(
        await f.runtime.prepareWorkspace(structuredClone(f.prepareRequest)),
      ).toEqual(prepared);
      expect(await f.runtime.inspectWorkspace(prepared.workspace)).toEqual({
        clean: true,
        changedFiles: [],
      });
      await expect(
        f.runtime.prepareWorkspace({
          ...f.prepareRequest,
          baseSha: 'f'.repeat(40),
        }),
      ).rejects.toMatchObject({ category: 'bug', code: 'request_mismatch' });
    });
    it('checks out an existing worker branch in a fresh workspace and replays it stably', async () => {
      const first = await f.runtime.prepareWorkspace(f.prepareRequest);
      const rework = await f.runtime.prepareWorkspace(f.reworkRequest);
      expect(rework.workspace).not.toBe(first.workspace);
      expect(rework.path).not.toBe(first.path);
      expect(rework.baseSha).toBe(f.reworkRequest.baseBranch);
      expect(
        await f.runtime.prepareWorkspace(structuredClone(f.reworkRequest)),
      ).toEqual(rework);
      await expect(
        f.runtime.prepareWorkspace({
          ...f.reworkRequest,
          checkoutExisting: undefined,
        }),
      ).rejects.toMatchObject({ category: 'bug', code: 'request_mismatch' });
    });
    it('replays spawn and finds its correlation without creating another agent', async () => {
      const a = await f.runtime.spawnAgent(f.spawnRequest);
      expect(await f.runtime.spawnAgent(structuredClone(f.spawnRequest))).toBe(
        a,
      );
      expect(
        await f.runtime.findByCorrelation(
          f.session,
          f.spawnRequest.correlation.commandId,
        ),
      ).toBe(a);
      expect(await f.runtime.findByCorrelation(f.session, 'absent')).toBeNull();
    });
    it('reports request_mismatch as bug for reused command IDs with changed parameters', async () => {
      await f.runtime.spawnAgent(f.spawnRequest);
      await expect(
        f.runtime.spawnAgent({ ...f.spawnRequest, title: 'different' }),
      ).rejects.toMatchObject({ category: 'bug', code: 'request_mismatch' });
    });
    it('stop and release are idempotent; stopping never fabricates worker_done', async () => {
      const a = await f.runtime.spawnAgent(f.spawnRequest);
      await f.runtime.stop(a);
      await f.runtime.stop(a);
      const stopped = await f.runtime.observe(f.session, null);
      expect(
        stopped.events.filter((e) => e.type === 'agent.stopped'),
      ).toHaveLength(1);
      expect(stopped.events.some((e) => e.type === 'agent.done')).toBe(false);
      await f.runtime.release(a, { removeWorkspace: false });
      await f.runtime.release(a, { removeWorkspace: false });
      const released = await f.runtime.observe(f.session, stopped.cursor);
      expect(
        released.events.filter((e) => e.type === 'agent.exited'),
      ).toHaveLength(1);
      expect(await f.runtime.resolveCaller(f.identity(a))).toBe(a);
    });
    it('replays exactly the same batch for the same cursor, even after new events', async () => {
      const a = await f.runtime.spawnAgent(f.spawnRequest);
      const first = await f.runtime.observe(f.session, null);
      first.events.forEach((e) => RuntimeEventSchema.parse(e));
      await f.runtime.stop(a);
      expect(await f.runtime.observe(f.session, null)).toEqual(first);
      const next = await f.runtime.observe(f.session, first.cursor);
      expect(next.events.some((e) => e.type === 'agent.stopped')).toBe(true);
      expect(await f.runtime.observe(f.session, first.cursor)).toEqual(next);
      expect(
        next.events.every(
          (e) => !first.events.some((p) => p.externalKey === e.externalKey),
        ),
      ).toBe(true);
    });
    it('auto-releases two minutes after done without keepOpen and rejects follow-up', async () => {
      const a = await f.runtime.spawnAgent({
        ...f.spawnRequest,
        keepOpen: false,
      });
      await f.stimulus(a, 'done');
      const done = await f.runtime.observe(f.session, null);
      expect(done.events.some((e) => e.type === 'agent.done')).toBe(true);
      await f.advance(119_999);
      const early = await f.runtime.observe(f.session, done.cursor);
      expect(early.events.some((e) => e.type === 'agent.exited')).toBe(false);
      await f.advance(1);
      const released = await f.runtime.observe(f.session, early.cursor);
      expect(released.events.some((e) => e.type === 'agent.exited')).toBe(true);
      await expect(
        f.runtime.send(a, {
          subject: 'follow-up',
          body: 'work',
          correlation: { workflowId: 'wf', commandId: 'late-send' },
        }),
      ).rejects.toMatchObject({ category: 'guard' });
    });
    it('keepOpen allows a completed worker to receive a new turn after two minutes', async () => {
      const a = await f.runtime.spawnAgent({
        ...f.spawnRequest,
        keepOpen: true,
      });
      await f.stimulus(a, 'done');
      await f.advance(120_001);
      await f.runtime.send(a, {
        subject: 'follow-up',
        body: 'work',
        correlation: { workflowId: 'wf', commandId: 'follow-up' },
      });
      const events = (await f.runtime.observe(f.session, null)).events;
      expect(events.some((e) => e.type === 'agent.exited')).toBe(false);
      expect(events.at(-1)).toMatchObject({
        type: 'agent.status',
        state: 'working',
      });
    });
    it('ask false escalation and live turn-start-unobserved never become errors', async () => {
      const a = await f.runtime.spawnAgent(f.spawnRequest);
      await f.stimulus(a, 'ask-with-false-escalation');
      const batch = await f.runtime.observe(f.session, null);
      const question = batch.events.find((e) => e.type === 'agent.question');
      expect(question).toBeDefined();
      if (question?.type !== 'agent.question')
        throw new Error('Missing question');
      await f.runtime.answer(question.question, 'Answer', {
        workflowId: 'wf',
        commandId: 'answer',
      });
      await f.stimulus(a, 'turn-start-unobserved');
      const next = await f.runtime.observe(f.session, batch.cursor);
      expect(
        [...batch.events, ...next.events].some(
          (e) => e.type === 'agent.status' && e.state === 'error',
        ),
      ).toBe(false);
    });
  });
}
