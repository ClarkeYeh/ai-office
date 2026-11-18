import { afterEach, expect, it } from 'vitest';
import { FAKE_REPO } from '../main.js';
import {
  closeAll,
  office,
  sleep,
  until,
  isEnded,
} from './test-support/harness.js';

afterEach(closeAll);

it(
  'leaves the final PR open for requested changes, then explicitly merges through the authenticated dev route',
  { timeout: 60_000 },
  async () => {
    const o = await office();
    const id = await o.start();
    const finalGate = async () =>
      (await o.gates(id)).find(
        (g) => g.status === 'open' && g.stageKind === 'final-pr',
      );
    await o.drive(id, async () => Boolean(await finalGate()), {
      mergeFinalPr: false,
    });
    const gate = (await finalGate())!;
    const number = o.server.runners.get(id)!.state.workflow!.finalPr!;
    const ref = { repo: FAKE_REPO.github, number };
    await sleep(150);
    expect((await o.world.scm.getPR(ref)).state).toBe('open');
    expect(
      (
        await o.decide(gate, {
          decision: 'reject',
          comment: 'Add the missing edge case',
        })
      ).status,
    ).toBe(200);
    await until(
      finalGate,
      (g) => Boolean(g && g.gateId !== gate.gateId),
      'revised final PR gate',
    );
    expect((await o.world.scm.getPR(ref)).state).toBe('open');
    expect(o.server.runners.get(id)!.state.workflow!.finalPr).toBe(number);
    const merged = await o.ui.call('POST', '/dev/fake/scm/merge-final-pr', {
      number,
    });
    expect(merged.status).toBe(200);
    await until(() => o.readModel(id), isEnded, 'completion');
    expect((await o.readModel(id)).status).toBe('completed');
  },
);

it(
  'preserves an explicitly requested finalMergeMs timer',
  { timeout: 60_000 },
  async () => {
    const o = await office({ finalMergeMs: 300 });
    const id = await o.start();
    await o.drive(
      id,
      async () =>
        (await o.gates(id)).some(
          (g) => g.status === 'open' && g.stageKind === 'final-pr',
        ),
      { mergeFinalPr: false },
    );
    // No further drive: only the configured timer may merge this PR.
    await until(() => o.readModel(id), isEnded, 'configured owner timer');
    expect((await o.readModel(id)).status).toBe('completed');
  },
);

it(
  'closes a real HTTP merge-request in under five seconds with a pending response',
  { timeout: 60_000 },
  async () => {
    let merging = false;
    const o = await office({
      mergeDelay: () => {
        merging = true;
        return new Promise<void>(() => {});
      },
    });
    o.world.scm.setMergeDelay(1);
    const backend = o.world.backend!;
    let captured:
      import('../adapters/runtime-fake/index.js').FakeSubmission | undefined;
    o.world.backend = {
      submit: (request) => {
        if (request.submission.kind === 'merge-request' && !captured) {
          captured = request;
          return Promise.resolve();
        }
        return backend.submit(request);
      },
    };
    const id = await o.start();
    await o.drive(id, () => captured !== undefined);
    const request = captured!;
    const response = fetch(`${o.server.url}/agent/v1/submissions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${request.seatToken}`,
        'x-aio-terminal-handle': request.terminalHandle,
        'x-aio-pane-key': request.paneKey,
      },
      body: JSON.stringify(request.submission),
    });
    await until(async () => merging, Boolean, 'pending merge');
    const before = performance.now();
    const closing = o.close();
    const pending = await response;
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({
      status: 'pending',
      submissionId: expect.any(String),
    });
    await closing;
    expect(performance.now() - before).toBeLessThan(5000);
    // The external merge can finish while the backend is down. Recovery must
    // observe it and answer the same durable submission without issuing it twice.
    if (request.submission.kind !== 'merge-request')
      throw new Error('expected merge');
    await o.world.scm.mergeExternally({
      repo: FAKE_REPO.github,
      number: request.submission.payload.pr,
    });
    await o.restart();
    const retried = await fetch(o.server.url + '/agent/v1/submissions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + request.seatToken,
        'x-aio-terminal-handle': request.terminalHandle,
        'x-aio-pane-key': request.paneKey,
      },
      body: JSON.stringify(request.submission),
    });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      status: 'merged',
      pr: request.submission.payload.pr,
    });
  },
);
