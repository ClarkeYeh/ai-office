import { FakeScm } from '../../../adapters/scm-fake/index.js';
import { PortError } from '../../../ports/errors.js';
import type { ScmPort } from '../../../ports/scm.js';
import type { OwnerActions } from '../../../test-support/github/owner-actions.js';
import { ownerMarker } from '../../../test-support/github/safety.js';
import { SPIKE, type MixedBinding } from './mixed-office.js';

/** The canonical run ID that live tapes normalize to (T7). */
export const CANONICAL_RUN = '000000000001';
const marker = (commandId: string) => `<!-- ai-office:cmd=${commandId} -->`;

/**
 * The CI twin of the live binding: scm-fake behind the same scoping, bridge
 * and test namespace, on the wall clock (unknown-object compares creation
 * time with the workflow start).
 */
export function fakeBinding(): MixedBinding & { fake: FakeScm } {
  const fake = new FakeScm({ clock: { now: () => new Date() } });
  fake.addRepo(SPIKE, { viewerLogin: SPIKE.owner });
  const ref = (number: number) => ({ repo: SPIKE, number });
  const owner: OwnerActions = {
    async issue(number) {
      const o = fake.inspectObject(ref(number));
      return {
        body: o.body,
        labels: [...o.labels].sort(),
        state: o.state === 'open' ? 'open' : 'closed',
      };
    },
    async comments(number) {
      return fake
        .inspectObject(ref(number))
        .comments.map(({ body, author }) => ({ body, author }));
    },
    async pr(number) {
      const o = fake.inspectObject(ref(number));
      return { body: o.body, state: o.state };
    },
    async issuesWithMarker(commandId) {
      const found: number[] = [];
      for (let number = 1; ; number++) {
        let o;
        try {
          o = fake.inspectObject(ref(number));
        } catch {
          return found;
        }
        if (o.kind === 'issue' && o.body.includes(marker(commandId)))
          found.push(number);
      }
    },
    editIssueBody: (number, body) => fake.editIssueBody(ref(number), body),
    async createUnmarkedIssue(purpose) {
      return (
        await fake.createExternalIssue(SPIKE, {
          title: `[aio-test ${CANONICAL_RUN}] owner-created ${purpose}`,
          body: `Created by hand on GitHub (synthetic T15 check).\n\n${ownerMarker(`t${CANONICAL_RUN}:owner-${purpose}`)}`,
          labels: [],
        })
      ).number;
    },
    ownerComment: (number, purpose, text) =>
      fake.addExternalComment(
        ref(number),
        `${text}\n\n${ownerMarker(`t${CANONICAL_RUN}:owner-${purpose}`)}`,
      ),
    setPrState: (number, state) => fake.updatePR(ref(number), { state }),
  };
  let down = false;
  const scm = new Proxy(fake as ScmPort, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (down)
          return Promise.reject(
            new PortError('transient', 'github_unavailable', 'Injected outage'),
          );
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return {
    mode: 'fake',
    fake,
    scm,
    faults: {
      loseNextCreateIssue(listLagMs) {
        fake.loseNextResponse('createIssue');
        fake.setListLag(listLagMs);
      },
      setScmDown(value) {
        down = value;
      },
    },
    runId: CANONICAL_RUN,
    pusher: {
      push: async ({ branch, base }) => fake.pushBranch(SPIKE, branch, base),
    },
    owner,
    stepTimeoutMs: 120_000,
  };
}
