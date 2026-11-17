import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SUBMISSION_HEADER_NAMES } from '@ai-office/contracts/agent-submission';
import {
  agentRefOf,
  closeAll,
  golden,
  isEnded,
  office,
  until,
} from './test-support/harness.js';
import type { Json, Office } from './test-support/harness.js';

afterEach(closeAll);

/*
 * §25 crash recovery at each outbox window, through the composed backend: the
 * backend's port call is held (before or after its external side effect), the
 * backend is closed — the held call never answers, like a killed process — and
 * a new backend starts on the same data directory and the same fake world.
 */

const LEAD_SPAWN = '/meeting/1/spawn/lead';
const never = new Promise<never>(() => undefined);
const isLeadSpawn = (operation: string, args: unknown[]) =>
  operation === 'spawnAgent' &&
  (args[0] as { title: string }).title.endsWith(LEAD_SPAWN);
const spawnCommand = (events: Json[]) =>
  events.filter(
    (e) =>
      e.type === 'command.issued' &&
      e.payload.kind === 'runtime.spawnAgent' &&
      e.payload.commandId.endsWith(LEAD_SPAWN),
  );
const tokenIn = (spec: string) => /aio_seat_[A-Za-z0-9_-]+/.exec(spec)![0];

async function crashDuringLeadSpawn(window: 'before-call' | 'after-call') {
  let armed = true;
  const performed: { specPath: string; specSha256: string; spec: string }[] =
    [];
  // The process dies here: agents can no longer reach it (`ai-office submit`
  // exits 4 and the agent retries) until the next backend listens.
  const crash = () => {
    o.world.backend = undefined;
    return never;
  };
  const o: Office = await office({
    intercept: async (operation, args, call) => {
      if (!isLeadSpawn(operation, args)) return call();
      // The prompt names the spec file the agent reads (§11.5).
      const [, specPath, specSha256] =
        /spec at (\S+) \(sha256 ([0-9a-f]{64})\)/.exec(
          (args[0] as { prompt: string }).prompt,
        )!;
      const request = { specPath: specPath!, specSha256: specSha256! };
      if (armed && window === 'before-call') return crash();
      const result = await call();
      performed.push({
        ...request,
        spec: readFileSync(request.specPath, 'utf8'),
      });
      if (armed) return crash(); // the agent exists; the backend never hears back
      return result;
    },
  });
  const workflowId = await o.start();
  await until(
    () => o.events(workflowId),
    (events) => spawnCommand(events).length === 1,
    'the lead spawn to be issued',
  );
  return {
    o,
    workflowId,
    performed,
    restart: async () => {
      armed = false; // the new process's calls go through
      await o.restart(); // the old one waits for the held call, then gives up
    },
  };
}

const finish = async (o: Office, workflowId: string) => {
  const final = await o.drive(workflowId, isEnded);
  expect(final.status).toBe('completed');
  return o.events(workflowId);
};

describe(
  'M1 acceptance: crash recovery at each outbox window',
  { timeout: 60_000 },
  () => {
    it('crash after command.issued, before the runtime call: restore re-issues it once with the same spec', async () => {
      const { o, workflowId, performed, restart } =
        await crashDuringLeadSpawn('before-call');
      const issued = spawnCommand(await o.events(workflowId))[0]!;
      expect(performed).toEqual([]);
      await restart();
      const events = await finish(o, workflowId);
      // Exactly one lead agent was spawned, from the spec recorded at issue time.
      expect(performed).toMatchObject([
        {
          specPath: issued.payload.args.specPath,
          specSha256: issued.payload.args.specSha256,
        },
      ]);
      expect(spawnCommand(events)).toHaveLength(1);
      expect(
        golden(events).filter((l) => l === 'meeting.concluded'),
      ).toHaveLength(1);
    });

    it('crash after the runtime spawned the agent, before command.succeeded: reconcile adopts it without a second spawn', async () => {
      const { o, workflowId, performed, restart } =
        await crashDuringLeadSpawn('after-call');
      await until(
        async () => performed.length,
        (n) => n === 1,
        'the external spawn',
      );
      await restart();
      const events = await finish(o, workflowId);
      expect(performed).toHaveLength(1);
      const commandId = spawnCommand(events)[0]!.payload.commandId as string;
      const outcomes = events.filter(
        (e) =>
          [
            'command.succeeded',
            'command.reconciled',
            'command.failed',
          ].includes(e.type) && e.payload.commandId === commandId,
      );
      // Found by its receipt: reconciled and completed together, never redone.
      expect(outcomes.map((e) => e.type)).toEqual([
        'command.reconciled',
        'command.succeeded',
      ]);
      expect(outcomes[0]!.payload.outcome).toBe('found');
      // The one lead attempt submitted the agenda exactly once.
      expect(
        events.filter(
          (e) =>
            e.type === 'submission.accepted' && e.payload.kind === 'agenda',
        ),
      ).toHaveLength(1);
    });

    it('crash between token issuance and command.issued: restore rotates the seat token; after issuance the spec is reused', async () => {
      const { o, workflowId, performed, restart } =
        await crashDuringLeadSpawn('before-call');
      const issued = spawnCommand(await o.events(workflowId))[0]!;
      const { specPath, specSha256 } = issued.payload.args as Json;
      const oldToken = tokenIn(readFileSync(specPath, 'utf8'));
      const cause = (await o.events(workflowId)).find(
        (e) => e.id === issued.causationId,
      )!;
      await o.server.close();
      // The crash happened one step earlier: the token and spec exist, but the
      // reaction that materialized them never committed its command.issued
      // (nor advanced the runner's reaction cursor past its cause).
      // Node's built-in driver: only store-sqlite may use better-sqlite3.
      const db = new DatabaseSync(`${o.dataDir}/data/ai-office.sqlite`);
      const removed = db
        .prepare('DELETE FROM events WHERE id = ?')
        .run(issued.id as string);
      db.prepare(
        `UPDATE ingest_cursors SET value_json = ? WHERE source = 'runner.last-reacted' AND scope = ?`,
      ).run(JSON.stringify((cause.seq as number) - 1), workflowId);
      // The spawn effect's receipt commits atomically with command.issued; it
      // is the cause's last effect (its seat.spawned effect ran before it).
      const receipts = (
        db
          .prepare(
            `SELECT scope FROM ingest_cursors WHERE source = 'runner.effect' AND scope LIKE ?`,
          )
          .all(`${workflowId}:${cause.id as string}:%`) as { scope: string }[]
      )
        .map((r) => r.scope)
        .sort((a, b) => Number(a.split(':')[2]) - Number(b.split(':')[2]));
      db.prepare(
        `DELETE FROM ingest_cursors WHERE source = 'runner.effect' AND scope = ?`,
      ).run(receipts.at(-1)!);
      db.close();
      expect(removed.changes).toBe(1);

      await restart();
      const reissued = await until(
        () => o.events(workflowId),
        (events) =>
          events.some(
            (e) =>
              e.type === 'command.succeeded' &&
              e.payload.commandId === issued.payload.commandId,
          ),
        'the spawn to be materialized and run again',
      );
      const args = spawnCommand(reissued)[0]!.payload.args as Json;
      // Restore rotated the token and rewrote the spec before issuing it.
      expect(performed).toHaveLength(1);
      const newToken = tokenIn(performed[0]!.spec);
      expect(newToken).not.toBe(oldToken);
      expect(args.specSha256).not.toBe(specSha256);
      expect(performed[0]!.specSha256).toBe(args.specSha256);
      expect(
        createHash('sha256').update(performed[0]!.spec).digest('hex'),
      ).toBe(args.specSha256);

      // The token that was never issued is dead: the gateway refuses it.
      const terminal = o.world.runtime.identity(
        agentRefOf(reissued, spawnCommand(reissued)[0]!.attemptId as string),
      );
      const stale = await fetch(`${o.server.url}/agent/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SUBMISSION_HEADER_NAMES.authorization]: `Bearer ${oldToken}`,
          [SUBMISSION_HEADER_NAMES.terminalHandle]: terminal.terminalHandle,
          [SUBMISSION_HEADER_NAMES.paneKey]: terminal.paneKey,
        },
        body: JSON.stringify({
          kind: 'agenda',
          payload: { topics: [{ id: 't', title: 'T', focusByRole: {} }] },
        }),
      });
      expect(stale.status).toBe(401);

      const events = await finish(o, workflowId);
      expect(spawnCommand(events)).toHaveLength(1);
      expect(performed).toHaveLength(1);
    });

    it.each(['before-call', 'after-call'] as const)(
      'crash around a worker PR creation (%s): restore finds or opens exactly one PR',
      async (window) => {
        let armed = true;
        let opened = 0;
        const o: Office = await office({
          scmIntercept: async (operation, args, call) => {
            const draft = args[1] as { head?: string } | undefined;
            if (operation !== 'openPR' || !draft?.head?.endsWith('/feature'))
              return call();
            if (armed && window === 'before-call') {
              o.world.backend = undefined;
              return never;
            }
            const result = await call();
            opened++;
            if (armed) {
              o.world.backend = undefined;
              return never;
            }
            return result;
          },
        });
        const workflowId = await o.start();
        await o.drive(workflowId, async () =>
          (await o.events(workflowId)).some(
            (e) =>
              e.type === 'command.issued' &&
              e.payload.kind === 'scm.openPR' &&
              e.payload.commandId.endsWith('/feature/1/pr'),
          ),
        );
        if (window === 'after-call')
          await until(
            async () => opened,
            (n) => n === 1,
            'the PR',
          );
        armed = false;
        await o.restart();
        const events = await finish(o, workflowId);
        expect(opened).toBe(1);
        const commandId = events.find(
          (e) =>
            e.type === 'command.issued' &&
            e.payload.kind === 'scm.openPR' &&
            e.payload.commandId.endsWith('/feature/1/pr'),
        )!.payload.commandId as string;
        expect(
          events
            .filter(
              (e) =>
                e.type === 'command.issued' &&
                e.payload.commandId === commandId,
            )
            .map((e) => e.type),
        ).toEqual(['command.issued']);
        if (window === 'after-call')
          expect(
            events.find(
              (e) =>
                e.type === 'command.reconciled' &&
                e.payload.commandId === commandId,
            )?.payload.outcome,
          ).toBe('found');
        // One PR per item, both merged by the merge queue.
        expect(
          events
            .filter((e) => e.type === 'workitem.merged')
            .map((e) => [e.payload.itemKey, e.payload.pr]),
        ).toEqual([
          ['feature', 4],
          ['dependent', 5],
        ]);
      },
    );
  },
);
