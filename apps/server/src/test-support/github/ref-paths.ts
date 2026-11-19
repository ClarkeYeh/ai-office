import { expect } from 'vitest';
import type { GithubBindingFactory } from './contract-binding.js';
import { contractRepo, contractUrl } from './contract-transport.js';
import { FakeClock } from '../services.js';

/** Uses the actual encoded ref URLs, including a second slash in the branch. */
export async function encodedRefScenario(
  fetch: typeof globalThis.fetch,
  runId: string,
  startedAt: string,
  create: GithubBindingFactory,
): Promise<void> {
  const clock = new FakeClock(startedAt);
  const scm = create({
    fetch,
    clock,
    sleep: async (ms) => {
      clock.advance(ms);
    },
    registeredAt: () => startedAt,
  });
  const name = `ai-office/t${runId}-encoded/path`;
  await scm.ensureBranch(contractRepo, name, 'main', {
    workflowId: `t${runId}`,
    commandId: `t${runId}:encoded`,
  });
  const response = await fetch(
    `${contractUrl}/git/ref/heads/${encodeURIComponent(name)}`,
  );
  expect(response.status).toBe(200);
  const result = (await response.json()) as {
    ref: string;
    object: { sha: string };
  };
  expect(result.ref).toBe(`refs/heads/${name}`);
  expect(result.object.sha).toMatch(/^[a-f0-9]{40}$/);
  await scm.deleteBranch(contractRepo, name);
  expect(
    (await fetch(`${contractUrl}/git/ref/heads/${encodeURIComponent(name)}`))
      .status,
  ).toBe(404);
}
