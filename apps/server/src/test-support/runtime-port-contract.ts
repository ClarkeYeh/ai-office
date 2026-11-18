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
  /**
   * Existing remote-only worker branch (no local branch, no worktree), pinned
   * to its comparison head, with a -r1 name; distinct from `prepareRequest`'s.
   */
  reworkRequest: Parameters<RuntimePort['prepareWorkspace']>[0] & {
    checkoutExisting: true;
  };
  spawnRequest: Parameters<RuntimePort['spawnAgent']>[0];
  /** Advancing also completes a spawn held by the spawn-in-flight stimulus. */
  advance(ms: number): void | Promise<void>;
  stimulus(
    agent: AgentRef,
    action:
      | 'done'
      | 'ask-with-false-escalation'
      | 'turn-start-unobserved'
      | 'identity-lost'
      | 'hijack'
      | 'check-timeout'
      | 'response-lost'
      | 'receipt-absent-after-consume'
      | 'spawn-in-flight'
      | 'rate-limited',
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

    it('restores a missing identity on observe and can send afterward', async () => {
      const a = await f.runtime.spawnAgent(f.spawnRequest);
      await f.stimulus(a, 'identity-lost');
      const batch = await f.runtime.observe(f.session, null);
      expect(
        batch.events.filter((e) => e.type === 'runtime.identity_restored'),
      ).toHaveLength(1);
      await f.runtime.send(a, {
        subject: 'resume',
        body: 'Continue',
        correlation: { workflowId: 'wf', commandId: 'restore-send' },
      });
      const next = await f.runtime.observe(f.session, batch.cursor);
      expect(
        next.events.some((e) => e.type === 'runtime.identity_restored'),
      ).toBe(false);
    });
    it('does not steal a hijacked session and resumes only after reclaim', async () => {
      const a = await f.runtime.spawnAgent(f.spawnRequest);
      await f.stimulus(a, 'hijack');
      const batch = await f.runtime.observe(f.session, null);
      expect(
        batch.events.some((e) => e.type === 'runtime.identity_hijacked'),
      ).toBe(true);
      const message = {
        subject: 'resume',
        body: 'Continue',
        correlation: { workflowId: 'wf', commandId: 'hijack-send' },
      };
      await expect(f.runtime.send(a, message)).rejects.toMatchObject({
        category: 'hijacked',
      });
      expect(await f.runtime.reclaimSession(f.session)).toEqual({
        reclaimed: true,
      });
      await f.runtime.send(a, message);
    });
    for (const fault of [
      'check-timeout',
      'receipt-absent-after-consume',
    ] as const) {
      it(
        fault + ' recovers each message once using the unchanged cursor',
        async () => {
          const a = await f.runtime.spawnAgent(f.spawnRequest);
          const initial = await f.runtime.observe(f.session, null);
          await f.stimulus(a, 'ask-with-false-escalation');
          await f.stimulus(a, fault);
          // An adapter may recover internally or expose a transient failure.
          const recovered = await f.runtime
            .observe(f.session, initial.cursor)
            .catch(async (error) => {
              expect(error).toMatchObject({ category: 'transient' });
              return f.runtime.observe(f.session, initial.cursor);
            });
          const questions = recovered.events.filter(
            (e) => e.type === 'agent.question',
          );
          expect(questions).toHaveLength(1);
          expect(await f.runtime.observe(f.session, initial.cursor)).toEqual(
            recovered,
          );
          const next = await f.runtime.observe(f.session, recovered.cursor);
          expect(next.events.some((e) => e.type === 'agent.question')).toBe(
            false,
          );
          expect(
            new Set(
              [...recovered.events, ...next.events].map((e) => e.externalKey),
            ).size,
          ).toBe(recovered.events.length + next.events.length);
        },
      );
    }
    it('retries a lost spawn response with the same command ID and AgentRef', async () => {
      const existing = await f.runtime.spawnAgent(f.spawnRequest);
      await f.stimulus(existing, 'response-lost');
      const request = {
        ...f.spawnRequest,
        correlation: { ...f.spawnRequest.correlation, commandId: 'lost-spawn' },
      };
      await expect(f.runtime.spawnAgent(request)).rejects.toMatchObject({
        category: 'transient',
      });
      const marker = await f.runtime.findCommandByMarker('lost-spawn');
      const a = await f.runtime.spawnAgent(request);
      expect(marker).toMatchObject({
        kind: 'runtime.spawnAgent',
        result: { agent: a },
      });
      expect(await f.runtime.spawnAgent(request)).toBe(a);
      const batch = await f.runtime.observe(f.session, null);
      expect(
        batch.events.filter((e) => e.type === 'agent.status' && e.agent === a),
      ).toHaveLength(1);
    });
    it('defers pending spawn events without treating the worker as unmanaged', async () => {
      const a = await f.runtime.spawnAgent(f.spawnRequest);
      const initial = await f.runtime.observe(f.session, null);
      await f.stimulus(a, 'spawn-in-flight');
      const pending = f.runtime.spawnAgent({
        ...f.spawnRequest,
        correlation: {
          ...f.spawnRequest.correlation,
          commandId: 'pending-spawn',
        },
      });
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      const during = await f.runtime.observe(f.session, initial.cursor);
      expect(settled).toBe(false);
      expect(during.events).toEqual([]);
      await f.advance(0);
      const spawned = await pending;
      const after = await f.runtime.observe(f.session, during.cursor);
      expect(
        after.events.some((e) => 'agent' in e && e.agent === spawned),
      ).toBe(true);
      expect(after.events.some((e) => e.type === 'agent.unmanaged')).toBe(
        false,
      );
    });
    it('returns a fresh cursor for each new empty batch', async () => {
      const first = await f.runtime.observe(f.session, null);
      const second = await f.runtime.observe(f.session, first.cursor);
      const third = await f.runtime.observe(f.session, second.cursor);
      expect(new Set([first.cursor, second.cursor, third.cursor]).size).toBe(3);
      expect([...first.events, ...second.events, ...third.events]).toEqual([]);
    });
    it('reports provider rate limits as information without failing the agent', async () => {
      const a = await f.runtime.spawnAgent(f.spawnRequest);
      await f.stimulus(a, 'rate-limited');
      const batch = await f.runtime.observe(f.session, null);
      batch.events.forEach((e) => RuntimeEventSchema.parse(e));
      expect(
        batch.events.filter((e) => e.type === 'agent.rate_limited'),
      ).toMatchObject([{ agent: a, evidence: 'worker-show' }]);
      expect(
        batch.events.some(
          (e) => e.type === 'agent.status' && e.state === 'error',
        ),
      ).toBe(false);
      expect(
        batch.events.some(
          (e) => e.type === 'agent.done' || e.type === 'agent.exited',
        ),
      ).toBe(false);
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
    it('never checks out a branch another worktree holds, nor accepts a suffixed name (W1)', async () => {
      await f.runtime.prepareWorkspace(f.reworkRequest);
      await expect(
        f.runtime.prepareWorkspace({
          ...f.reworkRequest,
          name: `${f.reworkRequest.name}-again`,
          correlation: { ...f.reworkRequest.correlation, commandId: 'again' },
        }),
      ).rejects.toMatchObject({ category: 'guard', code: 'branch_in_use' });
      // A new worktree on a taken name would be silently suffixed by Orca (§6.5).
      await expect(
        f.runtime.prepareWorkspace({
          ...f.prepareRequest,
          branch: f.reworkRequest.branch,
          name: `${f.prepareRequest.name}-taken`,
          correlation: { ...f.prepareRequest.correlation, commandId: 'taken' },
        }),
      ).rejects.toMatchObject({ category: 'guard' });
    });
    it('rework reuses the kept worktree; checkoutExisting works once it is removed', async () => {
      const kept = await f.runtime.prepareWorkspace(f.reworkRequest);
      const spawn = (commandId: string, workspace = kept.workspace) =>
        f.runtime.spawnAgent({
          ...f.spawnRequest,
          workspace: { kind: 'existing-worktree', workspace, readOnly: false },
          correlation: { ...f.spawnRequest.correlation, commandId },
        });
      const first = await spawn('first');
      await f.runtime.stop(first);
      await f.runtime.release(first, { removeWorkspace: false });
      expect(await f.runtime.inspectWorkspace(kept.workspace)).toEqual({
        clean: true,
        changedFiles: [],
      });
      const second = await spawn('second');
      const fallback = {
        ...f.reworkRequest,
        name: f.reworkRequest.name.replace(/-r1$/, '-r2'),
        correlation: { ...f.reworkRequest.correlation, commandId: 'r2' },
      };
      await expect(f.runtime.prepareWorkspace(fallback)).rejects.toMatchObject({
        category: 'guard',
        code: 'branch_in_use',
      });
      await f.runtime.stop(second);
      await f.runtime.release(second, { removeWorkspace: true });
      await expect(
        f.runtime.inspectWorkspace(kept.workspace),
      ).rejects.toMatchObject({ category: 'guard' });
      const fresh = await f.runtime.prepareWorkspace(fallback);
      expect(fresh.workspace).not.toBe(kept.workspace);
      expect(fresh.baseSha).toBe(f.reworkRequest.baseBranch);
      expect(await spawn('third', fresh.workspace)).toBeTruthy();
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
