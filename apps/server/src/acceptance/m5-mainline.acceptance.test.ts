import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeRuntime } from '../adapters/runtime-fake/index.js';
import {
  m5MainlineScenario,
  M5_FAKE_TAG,
} from '../adapters/runtime-fake/scenarios/m5-mainline.js';
import type { M5Review } from '../adapters/runtime-fake/scenarios/m5-mainline.js';
import { createFakeScm } from '../adapters/scm-fake/index.js';
import { createFakeUsage } from '../adapters/usage-fake/index.js';
import { FsSpecStore, SystemClock } from '../adapters/system/index.js';
import { FAKE_REPO, startServer } from '../main.js';
import type { FakeWorld, RunningServer } from '../main.js';
import { PortError } from '../ports/errors.js';
import {
  CODE_NAME,
  ITEM_KEYS,
  PENDING_LINE,
  mainlineItems,
  requirement,
  reviewedLine,
} from '../test-support/joint/scenario/m5-mainline.js';
import { mainlineTemplates } from '../test-support/joint/scenario/template.js';
import {
  browser,
  closeAll,
  liveAttemptsAtStageGates,
  sleep,
  tempHome,
  until,
} from './test-support/harness.js';
import type { Browser, Json } from './test-support/harness.js';

const repo = FAKE_REPO.github;
const servers: RunningServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  await closeAll();
});
const of = (events: Json[], type: string, key?: string) =>
  events.filter(
    (e) => e.type === type && (key === undefined || e.payload.itemKey === key),
  );
const never = new Promise<never>(() => undefined);
type Window = 'before-call' | 'after-call';

/**
 * External git/file facts for the fake world. scm-fake does not store files or
 * simulate textual conflicts. This binding supplies those facts at its boundary,
 * just as the existing progressive-merge acceptance test does. Only the reviewer
 * pushes the conflict resolution; only docs' worker writes the nonce.
 */
function fixture(home: string, crashWindow?: Window) {
  let world: FakeWorld;
  let armed = crashWindow !== undefined;
  let killed = false;
  let target: { number: number } | undefined;
  const readmes = new Map<string, { line: string; agent: string }>();
  const docsWrites: { head: string; line: string; agent: string }[] = [];
  const resolved: { pr: number; before: string; head: string; base: string }[] =
    [];
  const merges: number[] = [];
  const reviews = new Map<number, M5Review>();

  const makeWorld = (): FakeWorld => {
    const clock = new SystemClock();
    const specs = new FsSpecStore(`${home}/data`);
    const scm = createFakeScm({ clock });
    scm.addRepo(repo);
    const scenario = m5MainlineScenario({
      inspectReview: (review) => {
        reviews.set(review.pr, review);
        if (
          review.itemKey === 'sub' &&
          !resolved.some((r) => r.pr === review.pr)
        ) {
          const pr = { repo, number: review.pr };
          scm.setMergeable(pr, false);
          const object = scm.inspectObject(pr);
          const head = scm.pushBranch(repo, object.head);
          // A merge commit, not a replacement commit: preserve both parents.
          const saved = scm.snapshot();
          saved.repos[0]![1].parents.find(([sha]) => sha === head)![1] = [
            review.headSha,
            review.integrationHead,
          ];
          scm.restore(saved);
          scm.setMergeable(pr, true);
          resolved.push({
            pr: review.pr,
            before: review.headSha,
            head,
            base: review.integrationHead,
          });
          return { resolvedHead: head };
        }
        return review.itemKey === 'docs'
          ? { readmeLine: readmes.get(review.headSha)?.line ?? 'missing' }
          : {};
      },
    });
    const runtime = createFakeRuntime({
      clock,
      scenario,
      localRepos: {
        [FAKE_REPO.localPath]: {
          isGitMainWorktree: true,
          originUrl: `https://github.com/${repo.owner}/${repo.name}.git`,
          runtimeRepoId: FAKE_REPO.runtime.orcaRepoId,
        },
      },
      readSpec: (path, hash) => specs.read(path, hash),
      remoteHead: async (ref) =>
        (await scm.compareBranch(repo, ref, ref))?.headSha ?? null,
      onPush: ({ agent, branch, base }) => {
        const head = scm.pushBranch(repo, branch, base);
        if (!branch.endsWith('/docs')) return;
        const a = runtime.snapshot().agents.find((a) => a.ref === agent)!;
        const [, path, hash] = /spec at (\S+) \(sha256 ([0-9a-f]{64})\)/.exec(
          a.request.prompt,
        )!;
        const spec = specs.read(path!, hash!)!;
        const number = /already tracks pull request #(\d+)/.exec(spec)?.[1];
        const line = number ? reviewedLine(Number(number)) : PENDING_LINE;
        readmes.set(head, { line, agent });
        docsWrites.push({ head, line, agent });
      },
      submitter: (request) => {
        if (!world.backend)
          throw new PortError('transient', 'backend_down', 'Backend down');
        return world.backend.submit(request);
      },
      submitRetryMs: 250,
    });
    const external = {
      scenario: 'm5-mainline',
      runtime,
      scm,
      usage: createFakeUsage({ clock }),
      backend: undefined,
    } satisfies FakeWorld;
    // Hold the backend's port call; do not hold the external world's getPR/poll.
    const mergePR = scm.mergePR.bind(scm);
    scm.mergePR = async (pr, options) => {
      const key = reviews.get(pr.number)?.itemKey;
      const atK = armed && (key === 'mul' || key === 'sub');
      if (atK && crashWindow === 'before-call') {
        target = pr;
        killed = true;
        world.backend = undefined;
        return never;
      }
      const result = await mergePR(pr, options);
      merges.push(pr.number);
      if (atK) {
        target = pr;
        killed = true;
        world.backend = undefined;
        return never;
      }
      return result;
    };
    return external;
  };
  world = makeWorld();
  return {
    get world() {
      return world;
    },
    get killed() {
      return killed;
    },
    get target() {
      return target;
    },
    docsWrites,
    resolved,
    merges,
    restore() {
      armed = false;
      const saved = JSON.parse(
        JSON.parse(readFileSync(join(home, 'data/fake-world.json'), 'utf8'))
          .payload,
      );
      const old = world;
      world = makeWorld();
      world.runtime.restore(saved.runtime);
      world.scm.restore(saved.scm);
      world.usage.restore(saved.usage);
      expect(world.runtime).not.toBe(old.runtime);
      expect(world.scm).not.toBe(old.scm);
      expect(world.usage).not.toBe(old.usage);
    },
  };
}

async function boot(home: string, world?: FakeWorld, port = 0) {
  const server = await startServer({
    dev: true,
    fake: 'm5-mainline',
    port,
    env: { AI_OFFICE_HOME: home },
    print: () => undefined,
    ...(world ? { fakeWorld: world } : {}),
  });
  servers.push(server);
  return server;
}
async function prepare(home: string) {
  mkdirSync(join(home, 'templates'), { recursive: true });
  for (const [file, source] of Object.entries(await mainlineTemplates()))
    writeFileSync(join(home, 'templates', file), source);
  writeFileSync(join(home, 'config.toml'), '[budget]\nenforcement = "off"\n');
}
const eventsOf = async (ui: Browser, id: string): Promise<Json[]> => {
  const events: Json[] = [];
  let after = 0;
  for (;;) {
    const page = (
      await ui.call(
        'GET',
        `/api/v1/workflows/${id}/events?afterSeq=${after}&limit=1000`,
      )
    ).body;
    events.push(...page.events);
    if (!page.nextAfterSeq) return events;
    after = page.nextAfterSeq;
  }
};
async function start(ui: Browser) {
  const repoId = (await ui.call('GET', '/api/v1/repos')).body.repos[0].repoId;
  const result = await ui.call('POST', '/api/v1/workflows', {
    templateId: 'feature-to-pr',
    repoId,
    requirement: requirement(M5_FAKE_TAG),
  });
  expect(result.status).toBe(201);
  return result.body.workflowId as string;
}
/** Owner strategy: final PR is always held; escalation can be held across K. */
async function drive(
  ui: Browser,
  id: string,
  done: () => boolean | Promise<boolean>,
  holdAnswer = false,
) {
  await until(
    async () => {
      if (await done()) return true;
      const gates = (await ui.call('GET', '/api/v1/gates')).body
        .gates as Json[];
      for (const gate of gates.filter(
        (g) => g.workflowId === id && g.status === 'open',
      )) {
        if (gate.kind === 'exception') {
          expect(gate.exceptionKind).toBe('question-escalation');
          if (holdAnswer) continue;
          const qs = (await ui.call('GET', '/api/v1/questions')).body
            .questions as Json[];
          const q = qs.find(
            (q) => q.workflowId === id && q.status === 'escalated',
          );
          if (q)
            expect(
              (
                await ui.call(
                  'POST',
                  `/api/v1/questions/${encodeURIComponent(q.questionId)}/answer`,
                  { body: CODE_NAME },
                )
              ).status,
            ).toBe(200);
          continue;
        }
        if (gate.stageKind === 'final-pr') continue;
        const path = `/api/v1/gates/${encodeURIComponent(gate.gateId)}`;
        const detail = (await ui.call('GET', path)).body;
        const result = await ui.call('POST', `${path}/decision`, {
          decision: 'approve',
          expectedVersion: detail.version,
          ...(detail.conclusion
            ? {
                githubBodyHash:
                  detail.conclusion.githubBodyHash ??
                  detail.conclusion.renderedHash,
              }
            : {}),
        });
        expect([200, 409]).toContain(result.status);
      }
      return false;
    },
    Boolean,
    'm5-mainline progress',
    45_000,
  );
}
async function atFinal(ui: Browser, id: string) {
  return ((await ui.call('GET', '/api/v1/gates')).body.gates as Json[]).some(
    (g) =>
      g.workflowId === id && g.stageKind === 'final-pr' && g.status === 'open',
  );
}
async function usageSample(
  server: RunningServer,
  ui: Browser,
  id: string,
  total: number,
) {
  const attempt = Object.values(server.runners.get(id)!.state.attempts).find(
    (a) => a.itemKey === 'name',
  )!;
  const usage = server.fakeWorld!.usage;
  if (!usage.snapshot().sessions.some(([key]) => key === attempt.attemptId))
    usage.registerAttempt({
      attemptId: attempt.attemptId,
      agent: attempt.agent,
      dispatchId: attempt.agentRef!,
    });
  // Codex's session counters are cumulative; replaying an identical sample is a no-op.
  for (let n = 0; n < 2; n++)
    usage.append(attempt.attemptId, {
      inputUncached: total,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  await until(
    () => eventsOf(ui, id),
    (events) =>
      of(events, 'usage.tokens')
        .filter((e) => e.payload.attemptId === attempt.attemptId)
        .reduce((sum, e) => sum + e.payload.inputUncached, 0) === total,
    'cumulative usage without double counting',
  );
}
async function resumedStream(
  server: RunningServer,
  cookie: string,
  id: string,
  events: Json[],
  after: number,
) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 5000);
  try {
    const response = await fetch(
      `${server.url}/api/v1/stream?workflowId=${id}`,
      {
        headers: { cookie, 'last-event-id': String(after) },
        signal: abort.signal,
      },
    );
    expect(response.status).toBe(200);
    const expected = events.filter((e) => e.seq > after).map((e) => e.seq);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let ids: number[] = [];
    while (ids.length < expected.length) {
      const part = await reader.read();
      if (part.done) break;
      text += decoder.decode(part.value, { stream: true });
      ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    }
    expect(ids).toEqual(expected);
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
}
async function finish(server: RunningServer, ui: Browser, id: string) {
  await drive(ui, id, () => atFinal(ui, id));
  await usageSample(server, ui, id, 200);
  expect(server.fakeWorld!.runtime.activeAgents()).toEqual([]);
  const finalPr = server.runners.get(id)!.state.workflow!.finalPr!;
  expect(
    (await server.fakeWorld!.scm.getPR({ repo, number: finalPr })).state,
  ).toBe('open');
  await sleep(100);
  expect(
    (await server.fakeWorld!.scm.getPR({ repo, number: finalPr })).state,
  ).toBe('open');
  expect(
    (await ui.call('POST', '/dev/fake/scm/merge-final-pr', { number: finalPr }))
      .status,
  ).toBe(200);
  await until(
    async () =>
      (await ui.call('GET', `/api/v1/workflows/${id}`)).body.readModel.status,
    (s) => s === 'completed',
    'explicit final PR merge',
  );
  return eventsOf(ui, id);
}

function assertMainline(
  events: Json[],
  server: RunningServer,
  f: ReturnType<typeof fixture>,
) {
  expect(of(events, 'workitem.proposed')[0]!.payload.items).toEqual(
    mainlineItems(M5_FAKE_TAG),
  );
  expect(
    of(events, 'workitem.merged')
      .map((e) => e.payload.itemKey)
      .sort(),
  ).toEqual([...ITEM_KEYS].sort());
  const questions = server.runners.get(events[0]!.workflowId)!.state.questions;
  expect(
    Object.values(questions).map((q) => [q.itemKey, q.answer?.by]),
  ).toEqual([
    ['core', 'agent'],
    ['name', 'user'],
  ]);
  expect(of(events, 'message.escalated')).toHaveLength(1);
  expect(
    events.some(
      (e) => e.type === 'seat.status' && e.payload.state === 'waiting_input',
    ),
  ).toBe(true);
  expect(
    of(events, 'ondemand.stopped').map((e) => e.payload.purpose),
  ).toContain('oncall');
  expect(of(events, 'workitem.rework_requested', 'docs')).toHaveLength(1);
  const docsPr = of(events, 'workitem.merged', 'docs')[0]!.payload.pr;
  expect(
    of(events, 'workitem.merge_queued', 'docs').map((e) => e.payload.pr),
  ).toEqual([docsPr, docsPr]);
  expect(f.docsWrites.map((w) => w.line)).toEqual([
    PENDING_LINE,
    reviewedLine(docsPr),
  ]);
  expect(new Set(f.docsWrites.map((w) => w.agent)).size).toBe(2);
  expect(f.resolved).toHaveLength(1);
  const scm = server.fakeWorld!.scm.snapshot().repos[0]![1];
  const resolution = f.resolved[0]!;
  expect(scm.parents.find(([sha]) => sha === resolution.head)?.[1]).toEqual([
    resolution.before,
    resolution.base,
  ]);
  const subPr = of(events, 'workitem.merged', 'sub')[0]!.payload.pr;
  expect(
    scm.events.some(
      (e) =>
        e.type === 'pr.state' && e.pr.number === subPr && e.mergeable === false,
    ),
  ).toBe(true);
  expect(scm.objects.find(([n]) => n === subPr)?.[1].headSha).toBe(
    resolution.head,
  );
  const docs = of(events, 'workitem.dispatched', 'docs')[0]!;
  const parents = new Map(scm.parents);
  const ancestor = (sha: string, head: string): boolean =>
    sha === head || (parents.get(head) ?? []).some((p) => ancestor(sha, p));
  for (const key of ['mul', 'sub']) {
    const merge = of(events, 'workitem.merged', key)[0]!;
    expect(docs.seq).toBeGreaterThan(merge.seq);
    expect(ancestor(merge.payload.mergeCommitSha, docs.payload.baseSha)).toBe(
      true,
    );
  }
  // Implement's first-parent history contains exactly the five backend merges.
  const merged = of(events, 'workitem.merged');
  let head = merged.at(-1)!.payload.mergeCommitSha as string;
  for (const event of [...merged].reverse()) {
    expect(head).toBe(event.payload.mergeCommitSha);
    head = parents.get(head)![0]!;
  }
  expect(head).toBe(
    of(events, 'workitem.dispatched', 'core')[0]!.payload.baseSha,
  );
  expect(
    of(events, 'submission.accepted').filter(
      (e) => e.payload.kind === 'integration-report',
    ),
  ).toHaveLength(1);
  expect(of(events, 'workflow.completed')).toHaveLength(1);
  expect(
    of(events, 'usage.tokens').reduce(
      (sum, e) => sum + e.payload.inputUncached,
      0,
    ),
  ).toBe(200);
  expect(
    liveAttemptsAtStageGates(events).every((g) => g.live.length === 0),
  ).toBe(true);
  expect(events.filter((e) => e.type.startsWith('budget.'))).toEqual([]);
  expect(of(events, 'anomaly.raised')).toEqual([]);
  const keys = events.flatMap((e) => (e.externalKey ? [e.externalKey] : []));
  expect(new Set(keys).size).toBe(keys.length);
  expect(events.map((e) => e.seq)).toEqual(
    Array.from({ length: events.length }, (_, i) => i + events[0]!.seq),
  );
  const ids = of(events, 'command.issued').map((e) => e.payload.commandId);
  expect(new Set(ids).size).toBe(ids.length);
  const objects = scm.objects.map(([, o]) => o);
  expect(objects.filter((o) => o.kind === 'pr')).toHaveLength(6);
  const markers = objects.map((o) => /ai-office:cmd=([^ ]+)/.exec(o.body)?.[1]);
  expect(markers.every(Boolean)).toBe(true);
  expect(new Set(markers).size).toBe(markers.length);
}

describe('M5-T9: offline m5-mainline', { timeout: 90_000 }, () => {
  it('routes questions, resolves mul/sub, reworks docs on the same PR, then explicitly merges the final PR', async () => {
    const home = tempHome();
    await prepare(home);
    const f = fixture(home);
    const server = await boot(home, f.world);
    const ui = await browser(server);
    const id = await start(ui);
    const events = await finish(server, ui, id);
    assertMainline(events, server, f);
  });

  it.each(['before-call', 'after-call'] as const)(
    'recreates the persisted fake world at K (%s) and reconciles exactly once',
    async (window) => {
      const home = tempHome();
      await prepare(home);
      const f = fixture(home, window);
      let server = await boot(home, f.world);
      let ui = await browser(server);
      const id = await start(ui);
      await drive(ui, id, () => f.killed, true);
      const before = await eventsOf(ui, id);
      const pending = of(before, 'command.issued').filter(
        (issued) =>
          !before.some(
            (e) =>
              ['command.succeeded', 'command.failed'].includes(e.type) &&
              e.payload.commandId === issued.payload.commandId,
          ),
      );
      const issued = of(before, 'command.issued').find(
        (e) =>
          e.payload.kind === 'scm.mergePR' &&
          e.payload.args.pr.number === f.target!.number,
      )!;
      expect(issued).toBeDefined();
      expect(
        of(before, 'command.succeeded').some(
          (e) => e.payload.commandId === issued.payload.commandId,
        ),
      ).toBe(false);
      // Waiter is intentional; no owner answer is supplied until recovery finishes.
      expect(
        Object.values(server.runners.get(id)!.state.questions).some(
          (q) => q.itemKey === 'name' && q.status !== 'answered',
        ),
      ).toBe(true);
      const oldSession = ui.cookie;
      const port = server.port;
      await usageSample(server, ui, id, 100);
      await server.close();
      const filename = join(home, 'data/fake-world.json');
      expect(statSync(filename).mode & 0o777).toBe(0o600);
      f.restore();
      server = await boot(home, f.world, port);
      // SQLite sessions survive the new backend and all three new adapters.
      expect(
        (
          await fetch(`${server.url}/api/v1/workflows/${id}`, {
            headers: { cookie: oldSession },
          })
        ).status,
      ).toBe(200);
      ui = await browser(server);
      const events = await finish(server, ui, id);
      assertMainline(events, server, f);
      for (const pendingCommand of pending) {
        const commandId = pendingCommand.payload.commandId;
        expect(
          events.filter(
            (e) =>
              ['command.succeeded', 'command.failed'].includes(e.type) &&
              e.payload.commandId === commandId,
          ),
        ).toHaveLength(1);
        expect(
          of(events, 'command.reconciled').filter(
            (e) => e.payload.commandId === commandId,
          ),
        ).toHaveLength(1);
      }
      expect(events.filter((e) => e.seq <= before.at(-1)!.seq)).toEqual(before);
      const outcomes = events.filter(
        (e) =>
          e.payload.commandId === issued.payload.commandId &&
          ['command.succeeded', 'command.failed'].includes(e.type),
      );
      expect(outcomes.map((e) => e.type)).toEqual(['command.succeeded']);
      expect(
        of(events, 'command.reconciled').find(
          (e) => e.payload.commandId === issued.payload.commandId,
        )?.payload.outcome,
      ).toBe(window === 'before-call' ? 'redone' : 'found');
      expect(
        of(events, 'command.reconciled').some(
          (e) => e.payload.outcome === 'gave_up',
        ),
      ).toBe(false);
      expect(f.merges.filter((n) => n === f.target!.number)).toHaveLength(1);
      expect(
        of(events, 'gate.opened')
          .filter((e) => e.payload.kind === 'exception')
          .map((e) => e.payload.exceptionKind),
      ).toEqual(['question-escalation']);
      const runtime = f.world.runtime.snapshot();
      expect(runtime.agents.length).toBe(of(events, 'seat.spawned').length);
      expect(
        runtime.markers.filter(([, r]) => r.kind === 'runtime.openSession'),
      ).toHaveLength(1);
      for (const [session, mailbox] of runtime.sessions) {
        const offsets = runtime.cursors
          .filter(([, c]) => c.session === session)
          .map(([, c]) => c.offset);
        expect(Math.max(...offsets)).toBeGreaterThanOrEqual(mailbox.length);
      }
      await resumedStream(
        server,
        oldSession,
        id,
        events,
        before.at(-1)!.seq as number,
      );
      // No duplicate accepted submission when the in-flight merge-request retries.
      const accepted = of(events, 'submission.accepted').map(
        (e) => `${e.payload.attemptId}:${JSON.stringify(e.payload.submission)}`,
      );
      expect(new Set(accepted).size).toBe(accepted.length);
    },
  );

  it('runs the registered CLI scenario without a harness-injected world', async () => {
    const home = tempHome();
    await prepare(home);
    const server = await boot(home);
    const ui = await browser(server);
    const id = await start(ui);
    const events = await finish(server, ui, id);
    expect(of(events, 'workitem.merged')).toHaveLength(5);
    expect(of(events, 'workitem.rework_requested', 'docs')).toHaveLength(1);
  });
});
