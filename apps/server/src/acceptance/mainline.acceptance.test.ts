import { afterEach, describe, expect, it } from 'vitest';
import {
  closeAll,
  golden,
  isEnded,
  liveAgents,
  liveAttemptsAtStageGates,
  office,
} from './test-support/harness.js';
import type { Json } from './test-support/harness.js';

afterEach(closeAll);

const of = (events: Json[], type: string) =>
  events.filter((e) => e.type === type);

describe(
  'M1 acceptance: progressive-merge mainline through the composed server',
  { timeout: 60_000 },
  () => {
    it('golden event sequence: merge queue merges one by one; the dependent starts after its dependency merged', async () => {
      const o = await office();
      const workflowId = await o.start();
      const final = await o.drive(workflowId, isEnded);
      expect(final.status).toBe('completed');
      const events = await o.events(workflowId);
      expect(golden(events)).toMatchSnapshot();

      // Worker PRs merge during implement; integrate only wraps up.
      const merged = of(events, 'workitem.merged').map((e) => e.seq as number);
      const implementDone = of(events, 'stage.completed').find(
        (e) => e.payload.stageId === 'implement',
      )!.seq as number;
      expect(merged).toHaveLength(2);
      expect(Math.max(...merged)).toBeLessThan(implementDone);
      expect((final.workItems as Json[]).map((i) => [i.key, i.status])).toEqual(
        [
          ['feature', 'merged'],
          ['dependent', 'merged'],
        ],
      );
    });

    it("dispatches the dependent only after its dependency merged, from a base containing the dependency's merge commit", async () => {
      const o = await office();
      const workflowId = await o.start();
      await o.drive(workflowId, isEnded);
      const events = await o.events(workflowId);
      const mergedFeature = of(events, 'workitem.merged').find(
        (e) => e.payload.itemKey === 'feature',
      )!;
      const dispatched = (key: string) =>
        of(events, 'workitem.dispatched').find(
          (e) => e.payload.itemKey === key,
        )!;
      expect(dispatched('dependent').seq).toBeGreaterThan(mergedFeature.seq);
      // The fake merge creates a fresh commit that becomes the integration head.
      expect(dispatched('dependent').payload.baseSha).toBe(
        mergedFeature.payload.mergeCommitSha,
      );
      expect(dispatched('feature').payload.baseSha).not.toBe(
        mergedFeature.payload.mergeCommitSha,
      );
      // prepareWorkspace fetched the integration branch at that head (§7.3).
      const integration = (await o.readModel(workflowId)).integrationBranch;
      expect(o.world.runtime.fetchedBranches()).toContainEqual(
        expect.objectContaining({
          branch: integration,
          headSha: mergedFeature.payload.mergeCommitSha,
        }),
      );
    });

    it('keeps zero live agents whenever a stage gate is open and stops on-demand instances before the stage ends', async () => {
      const o = await office();
      const workflowId = await o.start();
      await o.drive(workflowId, isEnded);
      const events = await o.events(workflowId);

      const atGates = liveAttemptsAtStageGates(events);
      expect(atGates.map((g) => g.gateId.split('/')[1])).toEqual([
        'meeting',
        'breakdown',
        'final-pr',
      ]);
      expect(atGates.every((g) => g.live.length === 0)).toBe(true);
      // The fake Orca agrees whenever the driver saw a stage gate open.
      expect(o.stageGateChecks.length).toBeGreaterThanOrEqual(2);
      expect(o.stageGateChecks.every((c) => c.liveAgents === 0)).toBe(true);

      const stopped = of(events, 'ondemand.stopped');
      const started = of(events, 'ondemand.started');
      expect(stopped.map((e) => e.payload.purpose)).toEqual(
        started.map((e) => e.payload.purpose),
      );
      const implementDone = of(events, 'stage.completed').find(
        (e) => e.payload.stageId === 'implement',
      )!;
      for (const instance of stopped) {
        expect(instance.seq).toBeLessThan(implementDone.seq);
        const released = of(events, 'seat.released').find(
          (e) => e.payload.attemptId === instance.payload.attemptId,
        )!;
        expect(released.seq).toBeLessThan(implementDone.seq);
      }
      expect(liveAgents(o.world)).toBe(0);
    });

    it('records one seat.exited per attempt and no issue drift for its own label changes (T33 known issues)', async () => {
      const o = await office();
      const workflowId = await o.start();
      await o.drive(workflowId, isEnded);
      // Let the observation loop ingest the last runtime exits and SCM polls.
      await new Promise((resolve) => setTimeout(resolve, 600));
      const events = await o.events(workflowId);
      const exits = of(events, 'seat.exited').map((e) => e.payload.attemptId);
      expect(exits.length).toBeGreaterThan(0);
      expect(new Set(exits).size).toBe(exits.length);
      expect(exits.every((attemptId) => typeof attemptId === 'string')).toBe(
        true,
      );
      // The backend swaps the conclusion issue's labels after approval; the body
      // is unchanged, so that is not drift (§8.2).
      expect(of(events, 'scm.issue_drift')).toEqual([]);
    });
  },
);
