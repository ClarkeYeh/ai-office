import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { PortError } from '../ports/errors.js';
import {
  closeAll,
  isEnded,
  office,
  sleep,
  tempHome,
  until,
} from './test-support/harness.js';
import type { Json, Office } from './test-support/harness.js';

afterEach(closeAll);

/*
 * M5 §4.2 retention through the composed backend: on completion with the
 * start-time snapshot `delete-on-complete` (the default), engine issues
 * deterministic cleanup commands; `keep` issues none; a failed one is a
 * `cleanup-failed` warning that never pauses.
 */

const cleanupIssued = (events: Json[], workflowId: string) =>
  events.filter(
    (e) =>
      e.type === 'command.issued' &&
      (e.payload.commandId as string).startsWith(`${workflowId}/cleanup/`),
  );

const settled = async (o: Office, workflowId: string) =>
  until(
    () => o.events(workflowId),
    (events) => {
      const issued = cleanupIssued(events, workflowId).map(
        (e) => e.payload.commandId,
      );
      return (
        issued.length > 0 &&
        issued.every((id) =>
          events.some(
            (e) =>
              (e.type === 'command.succeeded' || e.type === 'command.failed') &&
              e.payload.commandId === id,
          ),
        )
      );
    },
    'cleanup commands to settle',
  );

const branches = (o: Office): string[] =>
  o.world.scm
    .snapshot()
    .repos.flatMap(([, repo]) => repo.branches.map(([name]) => name));

describe(
  'M5-T3 acceptance: retention on completion',
  { timeout: 90_000 },
  () => {
    it('golden: delete-on-complete disposes every worktree and deletes the workflow branches once', async () => {
      const o = await office();
      const workflowId = await o.start();
      const final = await o.drive(workflowId, isEnded);
      expect(final.status).toBe('completed');
      const events = await settled(o, workflowId);
      const started = events.find((e) => e.type === 'workflow.started')!;
      expect(started.payload.limits.workerBranchRetention).toBe(
        'delete-on-complete',
      );
      const shortId = started.payload.shortId as string;
      const issued = cleanupIssued(events, workflowId);
      // Ids and args are derived from state only, so they read the same every
      // run; each worktree is named by the command that created it.
      const creators = new Map<string, string>();
      for (const e of events) {
        if (e.type !== 'command.succeeded') continue;
        const issuedBy = events.find(
          (i) =>
            i.type === 'command.issued' &&
            i.payload.commandId === e.payload.commandId,
        )!.payload;
        if (e.payload.kind === 'runtime.prepareWorkspace')
          creators.set(
            e.payload.result.workspace as string,
            `prepare ${issuedBy.args.branch as string}`,
          );
        if (
          e.payload.kind === 'runtime.spawnAgent' &&
          e.payload.result.workspace !== undefined
        )
          creators.set(
            e.payload.result.workspace as string,
            `spawn ${issuedBy.args.workspace.branch as string}`,
          );
      }
      const normalized = issued.map((e) => {
        const p = e.payload;
        const id = (p.commandId as string).slice(workflowId.length);
        const ref =
          p.kind === 'runtime.disposeWorkspace'
            ? id.replace(
                p.args.workspace as string,
                `<${creators.get(p.args.workspace as string) ?? '?'}>`,
              )
            : id;
        return `${p.kind} ${ref.replaceAll(shortId, '<short>')}`;
      });
      expect(normalized).toMatchSnapshot();
      // Every worktree: workers' prepared ones and the leads' new-worktree spawns.
      const spawnedWorkspaces = events
        .filter(
          (e) =>
            e.type === 'command.succeeded' &&
            e.payload.kind === 'runtime.spawnAgent' &&
            e.payload.result.workspace !== undefined,
        )
        .map((e) => e.payload.result.workspace as string);
      expect(spawnedWorkspaces.length).toBeGreaterThan(0);
      for (const ws of spawnedWorkspaces)
        expect(
          issued.some(
            (e) =>
              e.payload.kind === 'runtime.disposeWorkspace' &&
              e.payload.args.workspace === ws,
          ),
        ).toBe(true);
      // Never the integration or default branch.
      const integration = started.payload.integrationBranch as string;
      for (const e of issued.filter(
        (e) => e.payload.kind === 'scm.deleteBranch',
      ))
        expect(e.payload.args.name).toMatch(
          new RegExp(`^ai-office/${shortId}/`),
        );
      const left = branches(o);
      expect(left).toContain(integration);
      expect(left).toContain(started.payload.repo.defaultBranch);
      expect(left.filter((b) => b.startsWith(`ai-office/${shortId}/`))).toEqual(
        [],
      );
      expect(
        events.filter(
          (e) => e.type === 'command.failed' || e.type === 'anomaly.detected',
        ),
      ).toEqual([]);
      expect(issued.every((e) => e.causationId !== undefined)).toBe(true);
      const completed = events.find((e) => e.type === 'workflow.completed')!;
      expect(issued.every((e) => e.causationId === completed.id)).toBe(true);
    });

    it('a restart after completion neither re-issues nor misses cleanup', async () => {
      const o = await office();
      const workflowId = await o.start();
      await o.drive(workflowId, isEnded);
      const before = await settled(o, workflowId);
      await o.restart();
      // Let recovery, the reconciler and the observation loop run.
      await sleep(800);
      const after = await o.events(workflowId);
      expect(cleanupIssued(after, workflowId)).toEqual(
        cleanupIssued(before, workflowId),
      );
      expect(after.filter((e) => e.type === 'command.issued').length).toBe(
        before.filter((e) => e.type === 'command.issued').length,
      );
    });

    it('keep: configured retention snapshots at start and issues no cleanup', async () => {
      const home = tempHome();
      writeFileSync(
        `${home}/config.toml`,
        '[retention]\nworkerBranches = "keep"\n',
      );
      const o = await office({ home });
      const workflowId = await o.start();
      await o.drive(workflowId, isEnded);
      await sleep(600);
      const events = await o.events(workflowId);
      expect(
        events.find((e) => e.type === 'workflow.started')!.payload.limits
          .workerBranchRetention,
      ).toBe('keep');
      expect(cleanupIssued(events, workflowId)).toEqual([]);
      // POST /cleanup stays available for `keep`.
      const { status, body } = await o.ui.call(
        'POST',
        `/api/v1/workflows/${workflowId}/cleanup`,
      );
      expect(status).toBeLessThan(300);
      expect(body).toEqual({ accepted: true });
      const manual = await until(
        () => o.events(workflowId),
        (all) =>
          all.some(
            (e) =>
              e.type === 'command.issued' &&
              e.payload.kind === 'scm.deleteBranch',
          ),
        'manual cleanup',
      );
      expect(cleanupIssued(manual, workflowId)).toEqual([]);
    });

    it('a failed cleanup command raises one cleanup-failed warning and never pauses', async () => {
      let workflowId = '';
      let refused: string | undefined;
      const ended = () =>
        o.server.runners.get(workflowId)?.state.workflow?.status ===
        'completed';
      // Stage-internal disposes run first; only one after completion is refused.
      const o: Office = await office({
        intercept: async (operation, args, call) => {
          if (
            operation === 'disposeWorkspace' &&
            refused === undefined &&
            ended()
          ) {
            refused = args[0] as string;
            throw new PortError('guard', 'workspace_unpushed', 'Unpushed');
          }
          return call();
        },
      });
      workflowId = await o.start();
      const final = await o.drive(workflowId, isEnded);
      expect(final.status).toBe('completed');
      await settled(o, workflowId);
      const events = await until(
        () => o.events(workflowId),
        (all) => all.some((e) => e.type === 'anomaly.detected'),
        'cleanup-failed anomaly',
      );
      const failed = events.filter((e) => e.type === 'command.failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]!.payload.kind).toBe('runtime.disposeWorkspace');
      const anomalies = events.filter((e) => e.type === 'anomaly.detected');
      expect(anomalies).toEqual([
        expect.objectContaining({
          payload: {
            kind: 'cleanup-failed',
            severity: 'warning',
            summary: `Cleanup left workspace ${refused} (workspace_unpushed)`,
            commandId: failed[0]!.payload.commandId,
          },
        }),
      ]);
      expect(events.some((e) => e.type === 'workflow.paused')).toBe(false);
      const model = await o.readModel(workflowId);
      expect(model.status).toBe('completed');
      expect(model.anomalies).toEqual([
        expect.objectContaining({
          kind: 'cleanup-failed',
          commandId: failed[0]!.payload.commandId,
        }),
      ]);
    });
  },
);
