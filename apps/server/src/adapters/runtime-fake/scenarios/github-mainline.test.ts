import { afterEach, expect, it } from 'vitest';
import {
  office,
  closeAll,
  isEnded,
} from '../../../acceptance/test-support/harness.js';
import { githubMainlineScenario } from './github-mainline.js';

afterEach(closeAll);

it('runs the GitHub mainline through the engine with scm-fake', async () => {
  const o = await office({ scenario: githubMainlineScenario() });
  const workflowId = await o.start();
  let retries = 0;
  const final = await o.drive(workflowId, isEnded, {
    onException: async (gate) => {
      expect(gate.exceptionKind).toBe('merge-blocked');
      expect(gate.content.itemKey).toBe('dependent');
      expect(
        (await o.decide(gate, { decision: 'option', optionId: 'retry' }))
          .status,
      ).toBe(200);
      retries++;
      return true;
    },
  });
  expect(final.status).toBe('completed');
  expect(retries).toBe(1);
  const events = await o.events(workflowId);
  const of = (type: string, key?: string) =>
    events.filter(
      (event) =>
        event.type === type &&
        (key === undefined || event.payload.itemKey === key),
    );
  expect(of('workitem.rework_requested', 'feature')).toHaveLength(1);
  const feature = of('workitem.dispatched', 'feature');
  expect(feature).toHaveLength(2);
  expect(feature[1]!.payload.branch).toBe(feature[0]!.payload.branch);
  expect(
    new Set(
      of('workitem.merge_queued', 'feature').map((event) => event.payload.pr),
    ).size,
  ).toBe(1);
  const dependent = of('workitem.dispatched', 'dependent');
  expect(dependent).toHaveLength(2);
  expect(dependent[1]!.payload.branch).toBe(
    `${dependent[0]!.payload.branch}-a2`,
  );
  expect(dependent[0]!.payload.baseSha).toBe(
    of('workitem.merged', 'feature')[0]!.payload.mergeCommitSha,
  );
  expect(
    of('command.issued').some(
      (event) =>
        event.payload.kind === 'scm.updatePR' &&
        event.payload.args.patch?.state === 'closed',
    ),
  ).toBe(true);
  expect(
    of('command.issued').some(
      (event) =>
        event.payload.kind === 'scm.comment' &&
        /pull\//.test(event.payload.args.body),
    ),
  ).toBe(true);
  expect(
    events.filter(
      (event) =>
        event.type === 'submission.accepted' &&
        event.payload.kind === 'answer-question',
    ),
  ).toHaveLength(1);
  expect(o.stageGateChecks.every((check) => check.liveAgents === 0)).toBe(true);
  const report = events.find(
    (event) =>
      event.type === 'submission.accepted' &&
      event.payload.kind === 'integration-report',
  );
  expect(report?.payload.submission.payload.merged).toEqual(
    of('workitem.merged').map((event) => event.payload.pr),
  );
  const workflow = o.server.runners.get(workflowId)!.state.workflow!;
  const integration = await o.world.scm.compareBranch(
    workflow.repo.github,
    workflow.integrationBranch,
    workflow.integrationBranch,
  );
  expect(integration?.headSha).not.toBe(
    of('workitem.merged', 'dependent')[0]!.payload.mergeCommitSha,
  );
  expect(workflow.finalPr).toBeDefined();
}, 60_000);
