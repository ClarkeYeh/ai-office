import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeScm } from '../../adapters/scm-fake/index.js';
import {
  checkAcceptance,
  parseFacts,
} from '../../test-support/acceptance-check/index.js';
import { REHEARSAL_REPO } from '../../test-support/joint/rehearsal/protocol.js';
import {
  runRehearsal,
  type RehearsalBinding,
  type RehearsalReport,
} from '../../test-support/joint/rehearsal/run.js';
import { rehearsalTracePath } from '../../test-support/joint/rehearsal/tapes.js';

/*
 * M5-T11 CI twin (M5_PLAN §2.4, §6.2): the same rehearsal as
 * `rehearsal.github.test.ts` — the killable `--dev --fake m5-mainline` child,
 * both exact kill windows (P1 createIssue, P2 mul/sub mergePR), each window's
 * reconcile judged on its own, the T10 checker — with scm-fake in this process
 * behind the same bridge, scoping and test namespace. Once the live run has
 * recorded `m5-rehearsal.trace.json`, segment 1 (everything before the first
 * kill) must have the same event semantics (M3-T15 ruling: no call-by-call
 * HTTP replay). Needs `pnpm -r build` (CI builds before `pnpm test`).
 */
const SPIKE = REHEARSAL_REPO.github;
const RUN = '000000000001';
const markerOf = (body: string) =>
  /<!-- ai-office:cmd=([a-zA-Z0-9:_/-]+) -->/.exec(body)?.[1];

export function fakeRehearsalBinding(): RehearsalBinding & { fake: FakeScm } {
  const fake = new FakeScm({ clock: { now: () => new Date() } });
  fake.addRepo(SPIKE, { viewerLogin: SPIKE.owner });
  const repo = () => fake.snapshot().repos[0]![1];
  const objects = () => repo().objects.map(([, o]) => o);
  const chain = (branch: string, stop?: string) => {
    const parents = new Map(repo().parents);
    const out: string[] = [];
    let sha = new Map(repo().branches).get(branch);
    for (let i = 0; sha && i < 200; i++) {
      out.unshift(sha);
      if (sha === stop) break;
      sha = parents.get(sha)?.[0];
    }
    return { out, parents };
  };
  return {
    mode: 'fake',
    fake,
    scm: fake,
    runId: RUN,
    pusher: {
      push: async ({ branch, base }) => fake.pushBranch(SPIKE, branch, base),
    },
    async issuesWithMarker(id) {
      return objects().filter(
        (o) => o.kind === 'issue' && markerOf(o.body) === id,
      ).length;
    },
    async mergesOf(branch, head) {
      const { out, parents } = chain(branch);
      return out.filter((sha) => parents.get(sha)?.[1] === head).length;
    },
    async maxObjectsPerMarker() {
      const counts = new Map<string, number>();
      for (const o of objects()) {
        const id = markerOf(o.body);
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return Math.max(0, ...counts.values());
    },
    async firstParents(branch, first) {
      const { out } = chain(branch, first);
      return out[0] === first ? out : [];
    },
    pollMs: 250,
    stallMs: 2 * 60_000,
  };
}

const bases: string[] = [];
afterAll(async () => {
  for (const base of bases)
    if (process.env.AIO_DEBUG_HOME) console.log('kept', base);
    else await rm(base, { recursive: true, force: true });
});

describe('M5-T11 rehearsal CI twin (scm-fake, two exact kill windows)', () => {
  it('reconciles P1 and P2 to exactly one Issue and one merge and reaches the final gate', async () => {
    const base = await mkdtemp(join(tmpdir(), 'aio-rehearsal-'));
    bases.push(base);
    const binding = fakeRehearsalBinding();
    const report: RehearsalReport = await runRehearsal(binding, {
      home: join(base, 'home'),
      judge: (events, facts) => checkAcceptance(events, parseFacts(facts)),
    });

    expect(report.failed).toEqual([]);
    expect(report.windows.map((w) => w.window)).toEqual(['P1', 'P2']);
    for (const w of report.windows) {
      expect(w.rows.every((r) => r.status === 'pass')).toBe(true);
      expect(w.objects).toBe(1);
      expect(w.restart.oldPid).not.toBe(w.restart.newPid);
      expect(w.readyWithReconcileMs).toBeLessThanOrEqual(60_000);
    }
    expect(report.finalGateOpened).toBe(true);
    expect(report.finalPr).toEqual(expect.any(Number));
    expect(report.owner.handOffs).toEqual([]);
    expect(report.checker?.summary.fail).toBe(0);
    if (existsSync(rehearsalTracePath)) {
      const trace = JSON.parse(readFileSync(rehearsalTracePath, 'utf8')) as {
        segment1: unknown;
      };
      expect(report.segment1).toEqual(trace.segment1);
    }
  }, 900_000);
});
