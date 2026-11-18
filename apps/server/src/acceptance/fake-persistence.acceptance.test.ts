import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { startServer } from '../main.js';
import type { RunningServer } from '../main.js';
import { mainlineScenario } from '../adapters/runtime-fake/mainline.js';
import {
  acceptanceWorld,
  browser,
  closeAll,
  tempHome,
  until,
} from './test-support/harness.js';
import type { Json } from './test-support/harness.js';

const servers: RunningServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  await closeAll();
});
const boot = async (home: string, fakeWorld?: RunningServer['fakeWorld']) => {
  const server = await startServer({
    dev: true,
    fake: 'mainline',
    port: 0,
    env: { AI_OFFICE_HOME: home },
    print: () => undefined,
    ...(fakeWorld ? { fakeWorld } : {}),
  });
  servers.push(server);
  return server;
};

it(
  'recreates all fake adapters mid meeting round 1 and finishes without duplicate spawns, Issues or PRs',
  { timeout: 60_000 },
  async () => {
    const home = tempHome();
    // Only slow the already-materialized participant actions, keeping mainline
    // role selection and future behavior unchanged on the fresh process boundary.
    const world = acceptanceWorld(home, {
      ...mainlineScenario,
      roles: {
        ...mainlineScenario.roles,
        participant: {
          ...mainlineScenario.roles.participant,
          send: (context) => {
            const script = mainlineScenario.roles.participant!.send!;
            const steps =
              typeof script === 'function' ? script(context) : script;
            return steps.map((step) => ({
              ...step,
              afterMs: (step.afterMs ?? 0) + 1500,
            }));
          },
        },
      },
    });
    let server = await boot(home, world);
    let ui = await browser(server);
    const repoId = (await ui.call('GET', '/api/v1/repos')).body.repos[0].repoId;
    const started = await ui.call('POST', '/api/v1/workflows', {
      templateId: 'feature-to-pr',
      repoId,
      requirement: 'Persist fake world',
    });
    expect(started.status).toBe(201);
    const id = started.body.workflowId as string;
    const events = async () =>
      (await ui.call('GET', `/api/v1/workflows/${id}/events?limit=1000`)).body
        .events as Json[];
    const midway = await until(
      events,
      (all) =>
        all.some(
          (e) => e.type === 'meeting.round_started' && e.payload.round === 1,
        ),
      'meeting round 1',
    );
    expect(midway.some((e) => e.type === 'meeting.round_completed')).toBe(
      false,
    );
    await server.close();
    const filename = join(home, 'data/fake-world.json');
    expect(statSync(filename).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(
      JSON.parse(readFileSync(filename, 'utf8')).payload,
    );
    expect(saved.runtime.scheduled.length).toBeGreaterThan(0);
    expect(
      saved.runtime.agents.every(
        (a: Json) => a.spec === undefined && a.behavior === undefined,
      ),
    ).toBe(true);

    // No old adapter is passed to startServer. All identities, cursors, receipts,
    // SCM objects and pending steps must come from the file, as after process exit.
    server = await boot(home);
    expect(server.fakeWorld).not.toBe(world);
    expect(server.fakeWorld!.runtime).not.toBe(world.runtime);
    ui = await browser(server);
    await until(
      async () => {
        const model = (await ui.call('GET', `/api/v1/workflows/${id}`)).body
          .readModel;
        for (const gate of (await ui.call('GET', '/api/v1/gates')).body
          .gates as Json[]) {
          if (gate.workflowId !== id || gate.status !== 'open') continue;
          expect(gate.kind).not.toBe('exception');
          if (gate.stageKind === 'final-pr') {
            const number = server.runners.get(id)!.state.workflow!.finalPr!;
            expect(
              (
                await ui.call('POST', '/dev/fake/scm/merge-final-pr', {
                  number,
                })
              ).status,
            ).toBe(200);
            continue;
          }
          const detail = (
            await ui.call(
              'GET',
              `/api/v1/gates/${encodeURIComponent(gate.gateId)}`,
            )
          ).body;
          const result = await ui.call(
            'POST',
            `/api/v1/gates/${encodeURIComponent(gate.gateId)}/decision`,
            {
              decision: 'approve',
              expectedVersion: detail.version,
              ...(detail.conclusion
                ? {
                    githubBodyHash:
                      detail.conclusion.githubBodyHash ??
                      detail.conclusion.renderedHash,
                  }
                : {}),
            },
          );
          expect([200, 409]).toContain(result.status);
        }
        return model.status;
      },
      (status) => status === 'completed',
      'mainline completion',
    );
    const all = await events();
    // Compare the durable agents themselves with successful spawn receipts.
    const runtime = server.fakeWorld!.runtime.snapshot();
    const spawnReceipts = runtime.markers.filter(
      ([, result]) => result.kind === 'runtime.spawnAgent',
    );
    expect(runtime.agents.length).toBe(spawnReceipts.length);
    const seats = all.filter((e) => e.type === 'seat.spawned');
    expect(new Set(seats.map((e) => e.payload.attemptId)).size).toBe(
      seats.length,
    );
    expect(runtime.agents.length).toBe(seats.length);
    const objects = server
      .fakeWorld!.scm.snapshot()
      .repos.flatMap(([, repo]) => repo.objects.map(([, object]) => object));
    const markers = objects.map(
      (object) => /<!-- ai-office:cmd=(.+?) -->/.exec(object.body)?.[1],
    );
    expect(markers.every(Boolean)).toBe(true);
    expect(new Set(markers).size).toBe(markers.length);
    expect(objects.filter((o) => o.kind === 'pr')).toHaveLength(3);
  },
);

it.each(['truncated', 'checksum', 'scenario', 'version'])(
  'rejects %s snapshots without overwriting them and releases the lock',
  async (kind) => {
    const home = tempHome();
    await (await boot(home)).close();
    const filename = join(home, 'data/fake-world.json');
    const envelope = JSON.parse(readFileSync(filename, 'utf8'));
    const state = JSON.parse(envelope.payload);
    if (kind === 'scenario') state.scenario = 'other';
    if (kind === 'version') state.version = 99;
    envelope.payload = JSON.stringify(state);
    envelope.sha256 = createHash('sha256')
      .update(envelope.payload)
      .digest('hex');
    if (kind === 'checksum') envelope.sha256 = 'invalid';
    const bad = kind === 'truncated' ? '{' : JSON.stringify(envelope);
    writeFileSync(filename, bad);
    await expect(boot(home)).rejects.toThrow(
      /Cannot restore fake world:.*delete .*fake-world.json/,
    );
    expect(readFileSync(filename, 'utf8')).toBe(bad);
    // Failed startup left no lock preventing recovery after explicit reset.
    writeFileSync(
      filename,
      JSON.stringify({
        ...envelope,
        payload: JSON.stringify({ ...state, version: 1, scenario: 'mainline' }),
        sha256: createHash('sha256')
          .update(
            JSON.stringify({ ...state, version: 1, scenario: 'mainline' }),
          )
          .digest('hex'),
      }),
    );
    await (await boot(home)).close();
  },
);

it('checkpoints mutations within one second and flushes the last change on close', async () => {
  const home = tempHome();
  const server = await boot(home);
  const filename = join(home, 'data/fake-world.json');
  const source = () =>
    JSON.parse(JSON.parse(readFileSync(filename, 'utf8')).payload).usage
      .source as string;
  server.fakeWorld!.usage.setSource('none');
  expect(source()).toBe('session-log');
  await until(
    async () => source(),
    (value) => value === 'none',
    'throttled checkpoint',
    2500,
  );
  server.fakeWorld!.usage.setSource('session-log');
  await server.close();
  expect(source()).toBe('session-log');
  expect(statSync(filename).mode & 0o777).toBe(0o600);
});
