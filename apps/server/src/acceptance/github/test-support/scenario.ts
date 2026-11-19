import { expect } from 'vitest';
import { bodyHash } from '@ai-office/domain';
import { golden, sleep, type Json } from '../../test-support/harness.js';
import { SPIKE, waitFor, type MixedOffice } from './mixed-office.js';

/** One M3_PLAN §6 "M3-T15" scenario outcome (never carries GitHub bodies). */
export interface StepResult {
  step: number;
  title: string;
  ok: boolean;
  attempts: number;
  ms: number;
  error?: string;
}

export interface MixedRun {
  workflowId: string;
  steps: StepResult[];
  events: Json[];
  /** GitHub objects this run observed (numbers only), for the report. */
  objects: {
    conclusion?: number;
    workItems: number[];
    workerPrs: number[];
    finalPr?: number;
    unknownIssue?: number;
  };
}

const of = (events: Json[], type: string, key?: string) =>
  events.filter(
    (e) => e.type === type && (key === undefined || e.payload.itemKey === key),
  );
const MARKER = /<!-- ai-office:cmd=t[a-f0-9]{12}:[^ ]+ -->/;
const OWNER_MARKER = /<!-- aio-test:owner=t[a-f0-9]{12}:owner-[a-z-]+ -->/;

/**
 * Steps 1–11 of M3_PLAN §6 "M3-T15", in order, against one workflow. The same
 * script runs live (scm-github on the spike) and in CI (scm-fake): only the
 * binding differs. The suite never merges the final PR (§1.4 GD).
 */
export async function runMixedMainline(o: MixedOffice): Promise<MixedRun> {
  const owner = o.binding.owner;
  const live = o.binding.mode === 'live';
  // > two SCM polls (SPEC §12.2: 15 s, also for an injected scm-fake).
  const pollMs = 35_000;
  const steps: StepResult[] = [];
  const objects: MixedRun['objects'] = { workItems: [], workerPrs: [] };
  const step = async (
    number: number,
    title: string,
    action: () => Promise<void>,
    attempts = 1,
  ) => {
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        await action();
        steps.push({
          step: number,
          title,
          ok: true,
          attempts: attempt,
          ms: Date.now() - started,
        });
        return;
      } catch (error) {
        if (attempt < attempts && error instanceof Retry) continue;
        steps.push({
          step: number,
          title,
          ok: false,
          attempts: attempt,
          ms: Date.now() - started,
          error: String((error as Error).message ?? error).slice(0, 400),
        });
        throw error;
      }
    }
  };
  const workflowId = await o.start();
  const events = () => o.events(workflowId);
  const until = <T>(
    read: () => Promise<T>,
    ok: (v: T) => boolean,
    what: string,
  ) => waitFor(o, workflowId, read, ok, what);
  const openGate = (match: (g: Json) => boolean, what: string) =>
    until(
      () => o.gates(workflowId),
      (gates) => gates.some((g) => g.status === 'open' && match(g)),
      what,
    ).then((gates) => gates.find((g) => g.status === 'open' && match(g))!);

  // Step 1 (part 1): the conclusion Issue opens with the pending labels.
  const meeting = await openGate(
    (g) => g.kind === 'stage' && g.stageKind === 'meeting',
    'the conclusion gate',
  );
  const conclusion = of(await events(), 'artifact.created').find(
    (e) => e.payload.purpose === 'conclusion',
  )!.payload.number as number;
  objects.conclusion = conclusion;
  await step(1, 'conclusion Issue labels and marker (opened)', async () => {
    const issue = await owner.issue(conclusion);
    expect(issue.labels).toEqual(
      expect.arrayContaining(['ai-office:conclusion', 'ai-office:pending']),
    );
    expect(issue.body).toMatch(MARKER);
  });

  // Steps 2–3: owner edits; the screen's stale hash is refused; approve the GitHub version.
  let approvedBody = '';
  await step(
    2,
    'GitHub edit → gate.content_updated{github}, version +1',
    async () => {
      // Reported product gap: an edit before the first poll that lists the
      // new Issue is never reported (its first sighting carries no drift).
      await sleep(pollMs);
      const before = await o.detail(meeting);
      const body = `${(await owner.issue(conclusion)).body}\n\nOwner edit on GitHub (T15 step 2).`;
      await owner.editIssueBody(conclusion, body);
      const after = await until(
        () => o.detail(meeting),
        (d) => d.version === before.version + 1,
        'the GitHub edit to reach the gate',
      );
      expect(after.conclusion.githubBodyHash).not.toBe(
        before.conclusion.githubBodyHash ?? before.conclusion.renderedHash,
      );
      const updated = of(await events(), 'gate.content_updated').filter(
        (e) => e.payload.gateId === meeting.gateId,
      );
      expect(updated.at(-1)!.payload).toMatchObject({
        source: 'github',
        version: after.version,
      });
      approvedBody = body;
    },
  );
  await step(
    3,
    'edit after the screen read its hash → 409 gate_content_changed',
    async () => {
      const seen = await o.detail(meeting);
      const body = `${approvedBody}\n\nSecond owner edit after the hash was read (T15 step 3).`;
      await owner.editIssueBody(conclusion, body);
      const stale = await o.decision(meeting, {
        decision: 'approve',
        expectedVersion: seen.version,
        githubBodyHash: seen.conclusion.githubBodyHash,
      });
      approvedBody = body;
      // A poll between the edit and the decision bumps the version instead.
      if (stale.body?.error?.code === 'gate_version_conflict')
        throw new Retry();
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('gate_content_changed');
    },
    3,
  );
  await step(
    2,
    'approve with the screen githubBodyHash → snapshot = GitHub version',
    async () => {
      const fresh = await until(
        () => o.detail(meeting),
        (d) => d.conclusion.githubBodyHash === bodyHash(approvedBody),
        'the second edit to reach the gate',
      );
      const approved = await o.decision(meeting, {
        decision: 'approve',
        expectedVersion: fresh.version,
        githubBodyHash: fresh.conclusion.githubBodyHash,
      });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      const decided = of(await events(), 'gate.decided').find(
        (e) => e.payload.gateId === meeting.gateId,
      )!;
      expect(decided.payload.approvedSnapshot).toMatchObject({
        source: 'github',
        body: approvedBody,
      });
    },
  );
  await step(
    1,
    'conclusion Issue relabelled and decision comment with marker',
    async () => {
      const issue = await until(
        () => owner.issue(conclusion),
        (i) => i.labels.includes('ai-office:approved'),
        'the approval labels',
      );
      expect(issue.labels).not.toContain('ai-office:pending');
      const comments = await until(
        () => owner.comments(conclusion),
        (cs) => cs.some((c) => MARKER.test(c.body)),
        'the decision comment',
      );
      expect(comments.find((c) => MARKER.test(c.body))!.author).toBe(
        SPIKE.owner,
      );
    },
  );

  // Step 4: work-item Issues after the breakdown approval.
  const breakdown = await openGate(
    (g) => g.kind === 'stage' && g.stageKind === 'planning',
    'the breakdown gate',
  );
  expect(
    (
      await o.decision(breakdown, {
        decision: 'approve',
        expectedVersion: (await o.detail(breakdown)).version,
      })
    ).status,
  ).toBe(200);
  await step(
    4,
    'work-item Issues with work-item, agent and role labels',
    async () => {
      const created = await until(
        events,
        (es) =>
          of(es, 'artifact.created').filter(
            (e) => e.payload.purpose === 'work-item',
          ).length >= 2,
        'the work-item Issues',
      );
      objects.workItems = of(created, 'artifact.created')
        .filter((e) => e.payload.purpose === 'work-item')
        .map((e) => e.payload.number as number);
      for (const number of objects.workItems) {
        const issue = await owner.issue(number);
        expect(issue.labels).toContain('ai-office:work-item');
        expect(issue.labels.some((l) => l.startsWith('agent:'))).toBe(true);
        expect(issue.labels.some((l) => l.startsWith('role:'))).toBe(true);
        expect(issue.body).toMatch(MARKER);
      }
    },
  );

  // Implement: the merge queue rejects `dependent` once; the owner retries it.
  let retries = 0;
  const finalGate = await (async () => {
    for (;;) {
      const gates = await o.gates(workflowId);
      const final = gates.find(
        (g) => g.status === 'open' && g.stageKind === 'final-pr',
      );
      if (final) return final;
      for (const gate of gates.filter((g) => g.status === 'open')) {
        if (gate.kind === 'exception') {
          expect(gate.exceptionKind, JSON.stringify(gate)).toBe(
            'merge-blocked',
          );
          expect(gate.content.itemKey).toBe('dependent');
          const decided = await o.decision(gate, {
            decision: 'option',
            optionId: 'retry',
            expectedVersion: (await o.detail(gate)).version,
          });
          expect(decided.status).toBe(200);
          retries++;
        } else if (
          gate.stageKind !== 'meeting' &&
          gate.stageKind !== 'planning'
        ) {
          throw new Error(`Unexpected stage gate ${gate.stageKind}`);
        }
      }
      await sleep(live ? 1000 : 25);
      const status = (await o.readModel(workflowId)).status;
      if (['failed', 'cancelled', 'completed'].includes(status))
        throw new Error(`Workflow ended early: ${status}`);
    }
  })();
  const all = await events();
  objects.workerPrs = of(all, 'artifact.created')
    .filter((e) => e.payload.kind === 'pr' && e.payload.purpose === 'worker')
    .map((e) => e.payload.number as number);
  const finalPr = of(all, 'artifact.created').find(
    (e) => e.payload.kind === 'pr' && e.payload.purpose === 'final',
  )!.payload.number as number;
  objects.finalPr = finalPr;

  await step(
    5,
    'worker PRs (Refs #n, marker) merged with expected head and base',
    async () => {
      const workItemByKey = new Map(
        of(all, 'artifact.created')
          .filter((e) => e.payload.purpose === 'work-item')
          .map((e) => [
            e.payload.itemKey as string,
            e.payload.number as number,
          ]),
      );
      for (const pr of of(all, 'artifact.created').filter(
        (e) => e.payload.purpose === 'worker',
      )) {
        const body = (await owner.pr(pr.payload.number as number)).body;
        expect(body).toMatch(MARKER);
        expect(body).toContain(
          `Refs #${workItemByKey.get(pr.payload.itemKey as string)}`,
        );
      }
      const merges = of(all, 'command.issued').filter(
        (e) => e.payload.kind === 'scm.mergePR',
      );
      expect(merges.length).toBeGreaterThanOrEqual(2);
      for (const merge of merges) {
        expect(merge.payload.args.expectedHeadSha).toMatch(/^[a-f0-9]{40}$/);
        expect(merge.payload.args.expectedBaseSha).toMatch(/^[a-f0-9]{40}$/);
      }
      const merged = of(all, 'workitem.merged', 'feature')[0]!;
      const dependent = of(all, 'workitem.dispatched', 'dependent');
      expect(dependent.length).toBeGreaterThanOrEqual(1);
      for (const dispatched of dependent) {
        expect(dispatched.seq).toBeGreaterThan(merged.seq);
        // The dispatched base contains the upstream merge commit (compare API).
        const compare = await o.scm.compareBranch(
          SPIKE,
          dispatched.payload.baseSha as string,
          merged.payload.mergeCommitSha as string,
        );
        expect(compare?.ahead).toBe(0);
      }
    },
  );

  await step(
    6,
    'rework on the same PR; -a2 closes the old PR with a link',
    async () => {
      expect(of(all, 'workitem.rework_requested', 'feature')).toHaveLength(1);
      const feature = of(all, 'workitem.dispatched', 'feature');
      expect(feature).toHaveLength(2);
      expect(feature[1]!.payload.branch).toBe(feature[0]!.payload.branch);
      expect(
        new Set(
          of(all, 'workitem.merge_queued', 'feature').map((e) => e.payload.pr),
        ).size,
      ).toBe(1);
      expect(retries).toBe(1);
      const dependent = of(all, 'workitem.dispatched', 'dependent');
      expect(dependent).toHaveLength(2);
      expect(dependent[1]!.payload.branch).toBe(
        `${dependent[0]!.payload.branch}-a2`,
      );
      const prs = of(all, 'artifact.created').filter(
        (e) =>
          e.payload.purpose === 'worker' && e.payload.itemKey === 'dependent',
      );
      expect(prs).toHaveLength(2);
      const [old, next] = prs.map((e) => e.payload.number as number);
      expect((await owner.pr(old!)).state).toBe('closed');
      const comments = await until(
        () => owner.comments(old!),
        (cs) => cs.some((c) => c.body.includes(`/pull/${next}`)),
        'the superseded PR comment',
      );
      expect(comments.some((c) => MARKER.test(c.body))).toBe(true);
    },
  );

  await step(
    7,
    'adapter mergePR on the final PR → guard; PR stays open',
    async () => {
      const pr = await o.scm.getPR({ repo: SPIKE, number: finalPr });
      const refused = await o.scm
        .mergePR(
          { repo: SPIKE, number: finalPr },
          { method: 'merge', expectedHeadSha: pr.headSha },
        )
        .then(
          () => undefined,
          (error: unknown) => error as { category?: string },
        );
      expect(refused?.category).toBe('guard');
      expect((await owner.pr(finalPr)).state).toBe('open');
    },
  );

  await step(
    8,
    'final PR (Closes #n, worker PR list, marker); gate 3 open',
    async () => {
      const body = (await owner.pr(finalPr)).body;
      expect(body).toMatch(MARKER);
      for (const number of objects.workItems)
        expect(body).toContain(`Closes #${number}`);
      for (const event of of(all, 'workitem.merged'))
        expect(body).toContain(`#${event.payload.pr}`);
      expect(finalGate.status).toBe('open');
      expect((await o.detail(finalGate)).content.pr).toBe(finalPr);
    },
  );

  await step(
    9,
    'owner-created unmarked Issue → unknown-object, paused, continue',
    async () => {
      const number = await owner.createUnmarkedIssue('unknown-object');
      objects.unknownIssue = number;
      // The harness owner marker is present, yet AI Office must see no marker.
      const created = await owner.issue(number);
      expect(created.body).toMatch(OWNER_MARKER);
      expect(created.body).not.toContain('ai-office:cmd');
      await until(
        events,
        (es) =>
          of(es, 'anomaly.detected').some(
            (e) =>
              e.payload.kind === 'unknown-object' &&
              e.payload.number === number,
          ),
        'the unknown-object anomaly',
      );
      const paused = await until(
        () => o.readModel(workflowId),
        (w) => (w.pausedReasons as string[]).includes('anomaly'),
        'the anomaly pause',
      );
      expect(paused.status).not.toBe('failed');
      const gate = await openGate(
        (g) => g.kind === 'exception' && g.exceptionKind === 'anomaly',
        'the anomaly gate',
      );
      const decided = await o.decision(gate, {
        decision: 'option',
        optionId: 'continue',
        expectedVersion: (await o.detail(gate)).version,
      });
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      await until(
        () => o.readModel(workflowId),
        (w) => !(w.pausedReasons as string[]).includes('anomaly'),
        'the resume',
      );
    },
  );

  await step(
    10,
    'owner /approve comment on the conclusion Issue changes nothing',
    async () => {
      const before = await o.readModel(workflowId);
      const gates = await o.gates(workflowId);
      const seq = (await events()).at(-1)!.seq as number;
      await owner.ownerComment(conclusion, 'approve-comment', '/approve');
      const approveComment = (await owner.comments(conclusion)).find((c) =>
        c.body.startsWith('/approve'),
      )!;
      expect(approveComment.body).toMatch(OWNER_MARKER);
      expect(approveComment.body).not.toContain('ai-office:cmd');
      await sleep(pollMs);
      const after = (await events()).filter((e) => e.seq > seq);
      expect(
        after
          .map((e) => e.type as string)
          .filter((t) => /^(gate|workflow|stage|workitem)\./.test(t)),
      ).toEqual([]);
      expect((await o.readModel(workflowId)).status).toBe(before.status);
      expect(
        (await o.gates(workflowId)).map((g) => [g.gateId, g.status, g.version]),
      ).toEqual(gates.map((g) => [g.gateId, g.status, g.version]));
    },
  );

  await step(
    11,
    'final PR closed on GitHub → S9 display; reopened',
    async () => {
      await owner.setPrState(finalPr, 'closed');
      const closed = await until(
        () => o.detail(finalGate),
        (d) => d.content.prClosedAt !== undefined,
        'the S9 closed display',
      );
      expect(closed.status).toBe('open');
      expect(closed.options.map((x: Json) => x.optionId)).toEqual(
        expect.arrayContaining(['keep-open', 'abort']),
      );
      expect((await o.readModel(workflowId)).status).not.toBe('failed');
      await owner.setPrState(finalPr, 'open');
      const reopened = await until(
        () => o.detail(finalGate),
        (d) => d.content.prClosedAt === undefined,
        'the reopened final PR',
      );
      expect(reopened.status).toBe('open');
      expect((await owner.pr(finalPr)).state).toBe('open');
    },
  );

  await step(
    13,
    'merge commits: owner noreply author (no private email)',
    async () => {
      const merged = of(await events(), 'workitem.merged').map(
        (e) => e.payload.mergeCommitSha as string,
      );
      expect(merged.length).toBeGreaterThanOrEqual(2);
      for (const sha of merged)
        expect(await owner.commitIdentity(sha)).toEqual({
          authorNoreply: true,
          committerNoreply: true,
        });
    },
  );

  return { workflowId, steps, events: await events(), objects };
}

/** Thrown to rerun a step whose precondition raced a poll (rerun limit 2). */
class Retry extends Error {
  constructor() {
    super('retry');
  }
}

/**
 * Event-sequence semantics for the CI replay: the golden lines, projected so
 * that only causally ordered sequences are compared (stage/gate flow and each
 * work item's own history); everything else compares as a multiset.
 */
export function semantics(events: Json[]) {
  const lines = golden(events);
  const flow = lines.filter((l) =>
    /^(workflow|stage|gate\.(opened|decided|closed))/.test(l),
  );
  const items: Record<string, string[]> = {};
  for (const line of lines) {
    const match =
      /^workitem\.(dispatched|merge_queued|merged|rework_requested) (\S+)/.exec(
        line,
      );
    if (match) (items[match[2]!] ??= []).push(line);
  }
  return { flow, items, counts: [...lines].sort() };
}

/**
 * Step 12 (M3_PLAN §6 "M3-T15"): the first createIssue loses its response
 * while new rows list late → still exactly one conclusion Issue; then, with
 * the SCM breaker open, cancel → runtime stop/release are still sent.
 */
export async function runFaults(
  o: MixedOffice,
): Promise<{ workflowId: string; steps: StepResult[]; conclusion: number }> {
  const faults = o.binding.faults!;
  const live = o.binding.mode === 'live';
  const steps: StepResult[] = [];
  const started = Date.now();
  const record = async (title: string, action: () => Promise<void>) => {
    const at = Date.now();
    try {
      await action();
      steps.push({
        step: 12,
        title,
        ok: true,
        attempts: 1,
        ms: Date.now() - at,
      });
    } catch (error) {
      steps.push({
        step: 12,
        title,
        ok: false,
        attempts: 1,
        ms: Date.now() - at,
        error: String((error as Error).message ?? error).slice(0, 400),
      });
      throw error;
    }
  };
  // The adapter's pending window (SPEC §11.5) is 60 s; lag well inside it.
  faults.loseNextCreateIssue(live ? 20_000 : 1_000);
  const workflowId = await o.start();
  const events = () => o.events(workflowId);
  const until = <T>(
    read: () => Promise<T>,
    ok: (v: T) => boolean,
    what: string,
  ) =>
    waitFor(
      o,
      workflowId,
      read,
      ok,
      what,
      Math.max(o.binding.stepTimeoutMs, 240_000),
    );
  let conclusion = 0;
  let meetingGateId = '';
  await record(
    'lost createIssue response + list lag → one conclusion Issue',
    async () => {
      const meeting = await until(
        () => o.gates(workflowId),
        (gates) =>
          gates.some((g) => g.status === 'open' && g.stageKind === 'meeting'),
        'the conclusion gate',
      ).then((gates) => gates.find((g) => g.stageKind === 'meeting')!);
      meetingGateId = meeting.gateId as string;
      const all = await events();
      const issued = of(all, 'command.issued').filter(
        (e) => e.payload.kind === 'scm.createIssue',
      );
      expect(issued).toHaveLength(1);
      const commandId = issued[0]!.payload.commandId as string;
      const succeeded = of(all, 'command.succeeded').find(
        (e) => e.payload.commandId === commandId,
      )!;
      conclusion = succeeded.payload.result.issue as number;
      // The engine command ID carries the test namespace on GitHub.
      const remote = `t${o.binding.runId}:${commandId}`;
      expect(await o.binding.owner.issuesWithMarker(remote)).toEqual([
        conclusion,
      ]);
      expect(
        of(all, 'artifact.created').filter(
          (e) => e.payload.purpose === 'conclusion',
        ),
      ).toHaveLength(1);
      expect(of(all, 'anomaly.detected')).toEqual([]);
      const detail = await o.detail(meeting);
      const approved = await o.decision(meeting, {
        decision: 'approve',
        expectedVersion: detail.version,
        // The test namespace rewrites the marker, so the rendered hash never
        // matches GitHub: approve the GitHub body the screen shows.
        githubBodyHash:
          detail.conclusion.githubBodyHash ??
          bodyHash(detail.conclusion.githubBody as string),
      });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    },
  );
  await record(
    'SCM breaker open: cancel still sends runtime stop/release',
    async () => {
      const breakdown = await until(
        () => o.gates(workflowId),
        (gates) =>
          gates.some((g) => g.status === 'open' && g.stageKind === 'planning'),
        'the breakdown gate',
      ).then((gates) => gates.find((g) => g.stageKind === 'planning')!);
      const approved = await o.decision(breakdown, {
        decision: 'approve',
        expectedVersion: (await o.detail(breakdown)).version,
      });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      // Mid-implement: on-demand instances are alive and PR commands need GitHub.
      await until(
        events,
        (es) => of(es, 'ondemand.started').length > 0 && o.liveAgents() > 0,
        'a live on-demand instance in implement',
      );
      faults.setScmDown(true);
      try {
        // Polls and gate reads fail transiently; five in 60 s open the breaker.
        const health = await until(
          async () => {
            // The conclusion view reads the Issue through the (failing) SCM.
            await o.detail({ gateId: meetingGateId });
            const h = (await o.ui.call('GET', '/api/v1/health')).body;
            return h;
          },
          (h) => h.scm.breaker === 'open',
          'the open SCM breaker',
        );
        expect(health.scm.status).not.toBe('healthy');
        const seq = (await events()).at(-1)!.seq as number;
        const cancel = await o.ui.call(
          'POST',
          `/api/v1/workflows/${workflowId}/cancel`,
        );
        expect(cancel.status, JSON.stringify(cancel.body)).toBeLessThan(300);
        const after = await until(
          events,
          (es) => {
            const sent = es.filter(
              (e) =>
                e.seq > seq &&
                e.type === 'command.succeeded' &&
                ['runtime.stop', 'runtime.release'].includes(e.payload.kind),
            );
            return sent.some((e) => e.payload.kind === 'runtime.release');
          },
          'runtime stop/release during the SCM outage',
        );
        const kinds = after
          .filter((e) => e.seq > seq && e.type === 'command.succeeded')
          .map((e) => e.payload.kind as string);
        expect(kinds.some((k) => k.startsWith('scm.'))).toBe(false);
        expect(
          (await o.ui.call('GET', '/api/v1/health')).body.scm.breaker,
        ).toBe('open');
        await until(
          async () => o.liveAgents(),
          (n) => n === 0,
          'no live agents',
        );
      } finally {
        faults.setScmDown(false);
      }
      await until(
        () => o.readModel(workflowId),
        (w) => w.status === 'cancelled',
        'the cancelled workflow after the SCM recovers',
      );
    },
  );
  void started;
  return { workflowId, steps, conclusion };
}
