import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planning } from '../adapters/runtime-fake/mainline-actions.js';
import { FAKE_REPO } from '../main.js';
import { PortError } from '../ports/errors.js';
import {
  closeAll,
  golden,
  isEnded,
  office,
  sleep,
  until,
} from './test-support/harness.js';
import type { Json } from './test-support/harness.js';

afterEach(async () => {
  await closeAll();
  vi.useRealTimers();
});

const builtin = readFileSync(
  join(
    import.meta.dirname,
    '../../../../packages/templates/feature-to-pr.yaml',
  ),
  'utf8',
);

describe('M1 acceptance: gates', { timeout: 60_000 }, () => {
  it('reruns the meeting when its conclusion is rejected, then continues', async () => {
    const o = await office();
    const workflowId = await o.start();
    let decisions = 0;
    const final = await o.drive(workflowId, isEnded, {
      policy: (gate) =>
        gate.stageKind === 'meeting' && decisions++ === 0
          ? { decision: 'reject', comment: 'Narrow the scope' }
          : undefined,
    });
    expect(final.status).toBe('completed');
    const lines = golden(await o.events(workflowId));
    const rejected = lines.indexOf('gate.decided reject by user');
    expect(lines.slice(rejected, rejected + 3)).toEqual([
      'gate.decided reject by user',
      'stage.rerun_requested meeting',
      'stage.started meeting rerun',
    ]);
    expect(lines.filter((l) => l === 'meeting.concluded')).toHaveLength(2);
    expect(lines.filter((l) => l === 'gate.opened meeting stage')).toHaveLength(
      2,
    );
  });

  it('auto-approves optional gates that were turned off at start', async () => {
    const o = await office();
    const workflowId = await o.start({
      gateToggles: { conclusion: false, 'task-split': false },
    });
    // No policy: any human decision attempt would show up as `by user`.
    const final = await o.drive(workflowId, isEnded);
    expect(final.status).toBe('completed');
    const decided = golden(await o.events(workflowId)).filter((l) =>
      l.startsWith('gate.decided'),
    );
    expect(decided).toEqual([
      'gate.decided approve by auto',
      'gate.decided approve by auto',
    ]);
    // The non-optional final-PR gate cannot be turned off.
    const refused = await o.ui.call('POST', '/api/v1/workflows', {
      templateId: 'feature-to-pr',
      repoId: o.repoId,
      requirement: 'Turn off the final PR gate',
      gateToggles: { 'final-pr': false },
    });
    expect(refused.status).toBe(422);
  });

  it('reports template YAML validation errors, including merge-queue and escalateOn placement', async () => {
    const o = await office();
    const templates = join(o.dataDir, 'templates');
    writeFileSync(join(templates, 'broken-yaml.yaml'), 'id: [unclosed\n');
    writeFileSync(
      join(templates, 'misplaced.yaml'),
      builtin
        .replace('id: feature-to-pr', 'id: misplaced')
        // escalateOn is only valid on the implement stage (rev2.10 §5.2).
        .replace(
          'kind: integrate # 收尾',
          'kind: integrate\n    escalateOn: [ci-failed-twice] #',
        ),
    );
    writeFileSync(
      join(templates, 'ghost-reviewer.yaml'),
      builtin
        .replace('id: feature-to-pr', 'id: ghost-reviewer')
        // The merge-queue integrator must be a declared role.
        .replace('mergeQueue: { role: integrator', 'mergeQueue: { role: ghost'),
    );
    writeFileSync(
      join(templates, 'misnamed.yaml'),
      builtin.replace('id: feature-to-pr', 'id: another-name'),
    );

    const listed = await o.ui.call('GET', '/api/v1/templates');
    expect(listed.status).toBe(200);
    expect(listed.body.valid.map((t: Json) => t.id)).toEqual(['feature-to-pr']);
    const invalid = Object.fromEntries(
      (listed.body.invalid as Json[]).map((t) => [t.file, t.issues as Json[]]),
    );
    expect(Object.keys(invalid).sort()).toEqual([
      'broken-yaml.yaml',
      'ghost-reviewer.yaml',
      'misnamed.yaml',
      'misplaced.yaml',
    ]);
    expect(invalid['broken-yaml.yaml']!.length).toBeGreaterThan(0);
    expect(invalid['misnamed.yaml']).toContainEqual({
      path: 'id',
      message: expect.stringContaining('filename'),
    });
    expect(invalid['misplaced.yaml']).toEqual([
      {
        path: 'stages.3.escalateOn',
        message: 'escalateOn is only allowed on the implement stage',
      },
    ]);
    expect(
      invalid['ghost-reviewer.yaml']!.some((i: Json) =>
        i.path.includes('mergeQueue'),
      ),
      JSON.stringify(invalid['ghost-reviewer.yaml']),
    ).toBe(true);

    const start = await o.ui.call('POST', '/api/v1/workflows', {
      templateId: 'misplaced',
      repoId: o.repoId,
      requirement: 'Use the broken template',
    });
    expect(start.status).toBe(422);
    expect(start.body.error.code).toBe('template_invalid');
  });

  it('approves the GitHub version of a conclusion: label/comment changes are no 409, body edits are', async () => {
    const o = await office();
    const workflowId = await o.start();
    const gate = await until(
      () => o.gates(workflowId),
      (gates) => gates.some((g) => g.status === 'open'),
      'the conclusion gate',
    ).then((gates) => gates.find((g) => g.status === 'open')!);
    const issue = (await o.events(workflowId)).find(
      (e) =>
        e.type === 'artifact.created' && e.payload.purpose === 'conclusion',
    )!.payload.number as number;
    const ref = { repo: FAKE_REPO.github, number: issue };
    const detail = async () =>
      (
        await o.ui.call(
          'GET',
          `/api/v1/gates/${encodeURIComponent(gate.gateId)}`,
        )
      ).body;
    const before = await detail();

    // Someone relabels and comments on GitHub: the body hash is unchanged.
    await o.world.scm.setLabels(ref, ['ai-office:conclusion', 'triaged']);
    await o.world.scm.addExternalComment(ref, 'Looks good to me');
    await sleep(700); // > two SCM polls
    const relabelled = await detail();
    expect(relabelled.version).toBe(before.version);

    // Then the body is edited: the gate version bumps and the stale view is refused.
    const edited = `${(await o.world.scm.getIssue(ref)).body}\n\nEdited on GitHub.`;
    await o.world.scm.editIssueBody(ref, edited);
    const changed = await until(
      detail,
      (d) => d.version > before.version,
      'the GitHub edit to reach the gate',
    );
    const stale = await o.ui.call(
      'POST',
      `/api/v1/gates/${encodeURIComponent(gate.gateId)}/decision`,
      {
        decision: 'approve',
        expectedVersion: changed.version,
        githubBodyHash: before.conclusion.renderedHash,
      },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('gate_content_changed');

    const approved = await o.ui.call(
      'POST',
      `/api/v1/gates/${encodeURIComponent(gate.gateId)}/decision`,
      {
        decision: 'approve',
        expectedVersion: changed.version,
        githubBodyHash: changed.conclusion.githubBodyHash,
      },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const decided = (await o.events(workflowId)).find(
      (e) => e.type === 'gate.decided' && e.payload.gateId === gate.gateId,
    )!;
    expect(decided.payload.approvedSnapshot).toMatchObject({
      source: 'github',
      body: edited,
    });
  });

  it('approves an owner edit made before the first poll that lists the conclusion Issue (M3-T15 live finding)', async () => {
    const o = await office();
    const scm = o.world.scm;
    const poll = scm.poll.bind(scm);
    // GitHub lists a new Issue once, with its body at listing time: an edit
    // before that first sighting has no `issue.edited` of its own.
    let hold = true;
    vi.spyOn(scm, 'poll').mockImplementation(async (repo, cursor) => {
      if (hold && cursor !== null) return { events: [], cursor };
      const result = await poll(repo, cursor);
      const created = new Set(
        result.events.flatMap((e) =>
          e.type === 'repo.object_created' ? [e.ref.number] : [],
        ),
      );
      const events = [];
      for (const event of result.events) {
        if (event.type === 'issue.edited' && created.has(event.issue.number))
          continue;
        if (event.type === 'repo.object_created' && event.bodyHash) {
          const now = await scm.getIssue(event.ref);
          events.push({
            ...event,
            bodyHash: now.bodyHash,
            updatedAt: now.updatedAt,
          });
        } else events.push(event);
      }
      return { ...result, events };
    });
    const workflowId = await o.start();
    const gate = await until(
      () => o.gates(workflowId),
      (gates) => gates.some((g) => g.status === 'open'),
      'the conclusion gate',
    ).then((gates) => gates.find((g) => g.status === 'open')!);
    const issue = (await o.events(workflowId)).find(
      (e) =>
        e.type === 'artifact.created' && e.payload.purpose === 'conclusion',
    )!.payload.number as number;
    const ref = { repo: FAKE_REPO.github, number: issue };
    const path = `/api/v1/gates/${encodeURIComponent(gate.gateId)}`;
    const before = (await o.ui.call('GET', path)).body;
    const edited = `${(await scm.getIssue(ref)).body}\n\nEdited on GitHub at once.`;
    await scm.editIssueBody(ref, edited);
    hold = false;
    const shown = await until(
      async () => (await o.ui.call('GET', path)).body,
      (d) => d.version > before.version,
      'the first sighting to reach the gate',
    );
    expect(shown.conclusion.githubBodyHash).toBe(
      (await scm.getIssue(ref)).bodyHash,
    );
    const approved = await o.ui.call('POST', `${path}/decision`, {
      decision: 'approve',
      expectedVersion: shown.version,
      githubBodyHash: shown.conclusion.githubBodyHash,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const decided = (await o.events(workflowId)).find(
      (e) => e.type === 'gate.decided' && e.payload.gateId === gate.gateId,
    )!;
    expect(decided.payload.approvedSnapshot).toMatchObject({
      source: 'github',
      body: edited,
    });
  });

  it('opens an anomaly gate and pauses instead of the stage gate while an agent is still alive', async () => {
    // §8.1 waits 60 s + 30 s for agents to end; jump the backend's clock.
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['Date', 'setTimeout', 'clearTimeout'],
    });
    const stuck = new Set<unknown>();
    const o = await office({
      // The planning lead ignores stop and its terminal refuses to close.
      roles: { planner: { spawn: planning, ignoreStop: true } },
      intercept: async (operation, args, call) => {
        if (operation === 'spawnAgent') {
          const ref = await call();
          const title = (args[0] as { title: string }).title;
          if (title.endsWith('/breakdown/1/spawn/lead')) stuck.add(ref);
          return ref;
        }
        if (operation === 'release' && stuck.has(args[0]))
          throw new PortError('permanent', 'release_refused', 'Refused');
        return call();
      },
    });
    const workflowId = await o.start();
    await o.drive(workflowId, async () =>
      (await o.events(workflowId)).some(
        (e) =>
          e.type === 'timer.scheduled' &&
          e.payload.payload.purpose === 'gate-precheck',
      ),
    );
    vi.advanceTimersByTime(61_000);
    await until(
      () => o.events(workflowId),
      (events) => events.some((e) => e.payload.code === 'stage_close_restop'),
      'the second stop',
    );
    vi.advanceTimersByTime(31_000);
    const paused = await until(
      () => o.readModel(workflowId),
      (w) => (w.pausedReasons as string[]).includes('anomaly'),
      'the anomaly pause',
    );
    expect(paused.status).toBe('running');
    const gates = await o.gates(workflowId);
    expect(gates.map((g) => [g.kind, g.exceptionKind, g.status])).toEqual([
      ['exception', 'anomaly', 'open'],
    ]);
    // The planning stage gate never opened while the lead was alive.
    const events = await o.events(workflowId);
    expect(
      events.filter(
        (e) =>
          e.type === 'gate.opened' &&
          e.payload.kind === 'stage' &&
          e.payload.stageId === 'breakdown',
      ),
    ).toEqual([]);

    // The owner aborts from the anomaly gate.
    const abort = await o.decide(gates[0]!, {
      decision: 'option',
      optionId: 'abort',
    });
    expect(abort.status, JSON.stringify(abort.body)).toBe(200);
    expect(
      (await o.events(workflowId)).some(
        (e) => e.type === 'workflow.cancel_requested',
      ),
    ).toBe(true);
  });
});
