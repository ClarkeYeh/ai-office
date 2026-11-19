import { afterEach, describe, expect, it, vi } from 'vitest';
import { GateViewSchema } from '@ai-office/contracts/api';
import { FAKE_REPO } from '../main.js';
import { PortError } from '../ports/errors.js';
import { closeAll, office, until } from './test-support/harness.js';

afterEach(async () => {
  await closeAll();
  vi.restoreAllMocks();
});

const sha = async (body: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
const MARKER = /\n*<!-- ai-office:cmd=.+? -->/g;

describe('G3b: conclusion gate bodies', { timeout: 60_000 }, () => {
  it('serves the live GitHub body and the marker-free rendered body', async () => {
    const o = await office();
    const workflowId = await o.start();
    const gate = await until(
      () => o.gates(workflowId),
      (gates) => gates.some((g) => g.status === 'open'),
      'the conclusion gate',
    ).then((gates) => gates.find((g) => g.status === 'open')!);
    const path = `/api/v1/gates/${encodeURIComponent(gate.gateId)}`;
    const detail = async () => {
      const response = await o.ui.call('GET', path);
      expect(response.status).toBe(200);
      return GateViewSchema.parse(response.body);
    };

    const before = (await detail()).conclusion!;
    expect(await sha(before.githubBody!)).toBe(before.renderedHash);
    expect(before.renderedBody).toBe(before.githubBody!.replace(MARKER, ''));
    expect(before.renderedBody).not.toContain('ai-office:cmd');

    const issue = (await o.events(workflowId)).find(
      (e) =>
        e.type === 'artifact.created' && e.payload.purpose === 'conclusion',
    )!.payload.number as number;
    const edited = `${before.githubBody}\n\nEdited on GitHub.`;
    await o.world.scm.editIssueBody(
      { repo: FAKE_REPO.github, number: issue },
      edited,
    );
    const after = (await detail()).conclusion!;
    expect(after.githubBody).toBe(edited);
    expect(after.renderedBody).toBe(before.renderedBody);

    vi.spyOn(o.world.scm, 'getIssue').mockRejectedValue(
      new PortError('transient', 'scm_unavailable', 'SCM down'),
    );
    const offline = (await detail()).conclusion!;
    expect(offline).not.toHaveProperty('githubBody');
    expect(offline.renderedBody).toBe(before.renderedBody);
  });
});
