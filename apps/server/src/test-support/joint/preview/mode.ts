/**
 * M5-T11b binding (M5_PLAN §2.5): the joint harness's `preview` mode.
 * `--dev --runtime orca` in a killable child (`../backend-child.ts`) with
 * `testOnly.scm = scm-gitremote` kept in this process and bridged over IPC,
 * so the stand-in's Issues/PRs survive the backend's `kill -9`. Real Orca and
 * real agents; agents and the stand-in push to the spike only inside the
 * harness-claimed namespace; nothing reaches the spike's `main` (the final
 * PR is merged by the stand-in's in-memory owner merge). GitHub-only facts
 * are judged by equivalent git reads of the spike clone (`facts.ts`).
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { OrcaHarness } from '../../orca/harness.js';
import { backendHome } from '../../orca/t17/office.js';
import { GitRemoteScm } from '../../orca/scm-gitremote/index.js';
import type { PrRef } from '../../../ports/refs.js';
import type { ScmPort } from '../../../ports/scm.js';
import { mainlineRun } from '../scenario/index.js';
import {
  keepPreventSleep,
  pinPort,
  previewLauncher,
  freePort,
} from '../backends.js';
import { orcaSide, type Mode } from '../run.js';
import {
  ancestry,
  conflictFacts,
  firstParents,
  integrationBranch,
  markerCounts,
  reworkFacts,
  type Git,
} from './facts.js';

const exec = promisify(execFile);

/** Stand-in reads that never wait for the namespace claim. */
const READS = new Set([
  'health',
  'poll',
  'inspectRepo',
  'compareBranch',
  'findByMarker',
  'listReviewComments',
]);

/** Checker rows the scm-gitremote world cannot judge, with the reason. */
export const PREVIEW_NA: Record<string, string> = {
  'nf.approve-comment':
    'no GitHub Issue in the scm-gitremote world (live: T12)',
  'v01.conflict':
    'scm-gitremote never reports mergeable (always null); judged by the git equivalent (conflictEquivalent: path A two-parent merge or path B rework)',
};

export interface PreviewMode extends Mode {
  /** The run's tag and requirement (T8 binding, world `gitremote`). */
  tag: string;
  /** Read-only git in the spike clone (after `fetch()`). */
  git: Git;
  fetch(): Promise<void>;
}

export async function previewMode(h: OrcaHarness): Promise<PreviewMode> {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME required');
  const binding = await mainlineRun('gitremote', new Date());
  const dir = await backendHome(h, {
    enforcement: binding.enforcement,
    templates: binding.templates,
  });
  const port = await freePort();
  // Coordinator ruling: the default `orca.preventSleep = true` (#14).
  await keepPreventSleep(dir);
  await pinPort(dir, port);
  const inner = await GitRemoteScm.create({
    remote: h.ledger.repoPath,
    harness: h,
  });
  let claimed!: () => void;
  const bound = new Promise<void>((r) => (claimed = r));
  let finalRef: PrRef | undefined;
  // Writes wait for the namespace claim; the final PR (base main) is noted.
  const scm = new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      const fn = (value as (...a: unknown[]) => unknown).bind(target);
      if (READS.has(String(property)) || String(property).startsWith('get'))
        return fn;
      return async (...args: unknown[]) => {
        await bound;
        const result = await fn(...args);
        if (
          property === 'openPR' &&
          (args[1] as { base?: string }).base === 'main'
        )
          finalRef = result as PrRef;
        return result;
      };
    },
  }) as unknown as ScmPort;
  const effects = await h.composedBackend(dir);
  const git: Git = async (args) =>
    (
      await exec('git', ['-C', h.ledger.repoPath, ...args], {
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;
  const fetch = async () => {
    await git(['fetch', '--quiet', 'origin']);
  };
  const repo = { owner: 'ClarkeYeh', name: 'ai-office-spike' };
  return {
    kind: 'preview',
    tag: binding.tag,
    git,
    fetch,
    side: orcaSide(h),
    pollMs: 2_000,
    sampleLocks: true,
    preventSleepChild: true,
    // The conclusion lives in the stand-in's memory: no owner /approve comment.
    checkerNa: PREVIEW_NA,
    home: dir,
    launcher: previewLauncher({
      home: dir,
      port,
      orcaHome: join(home, '.ai-office', 'orca-home'),
      scm,
      effects,
    }),
    afterFirstStart: () => effects.settle(),
    importObjects: async () => undefined,
    async integrationFile(log, path) {
      const branch = integrationBranch(log);
      if (!branch) return undefined;
      await fetch().catch(() => undefined);
      return git(['show', `origin/${branch}:${path}`]).catch(() => undefined);
    },
    onShortId: async () => claimed(),
    async finalPr() {
      if (!finalRef) throw new Error('Stand-in final PR not opened');
      // §2.2.4: the stand-in's explicit merge replaces the owner's (in memory;
      // the spike's main is never touched).
      inner.simulateOwnerMerge(finalRef);
    },
    async scmFacts(log) {
      await fetch().catch(() => undefined);
      const fp = await firstParents(git, log);
      return {
        ...(fp ? { integrationFirstParents: fp } : {}),
        markerCounts: await markerCounts(
          (id) => inner.findByMarker(repo, id),
          log,
        ),
      };
    },
    async checkerFacts(log) {
      await fetch().catch(() => undefined);
      return {
        ancestry: await ancestry(git, log),
        conflict: await conflictFacts(git, log),
        rework: await reworkFacts(git, log, binding.tag),
      };
    },
    dispose: () => inner.dispose(),
  };
}
