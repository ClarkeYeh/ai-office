import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { PortError } from '../../ports/errors.js';
import type { ScmPort } from '../../ports/scm.js';
import { remoteScm, serveScm, type ScmCall } from './scm-bridge.js';

/** Two ends of an IPC channel in one process (structured clone like `advanced`). */
function channelPair(scm: object) {
  const child = new EventEmitter();
  const serve = serveScm(scm as ScmPort);
  const parentEnd = {
    connected: true,
    send(message: unknown) {
      queueMicrotask(() => child.emit('message', structuredClone(message)));
    },
  };
  const childEnd = {
    on: (event: 'message', listener: (m: unknown) => void) =>
      child.on(event, listener),
    send(message: ScmCall) {
      queueMicrotask(() => serve(structuredClone(message) as never, parentEnd));
    },
  };
  return { childEnd, parentEnd };
}

describe('SCM bridge', () => {
  it('forwards calls with arguments and results', async () => {
    const calls: unknown[] = [];
    const { childEnd } = channelPair({
      async getPR(ref: unknown) {
        calls.push(ref);
        return { state: 'open', at: new Date(0) };
      },
    });
    const scm = remoteScm(childEnd);
    await expect(
      scm.getPR({ repo: { owner: 'o', name: 'n' }, number: 3 }),
    ).resolves.toEqual({ state: 'open', at: new Date(0) });
    expect(calls).toEqual([{ repo: { owner: 'o', name: 'n' }, number: 3 }]);
  });

  it('rebuilds PortError with category, code, retryability and retry delay', async () => {
    const { childEnd } = channelPair({
      async mergePR() {
        throw new PortError(
          'transient',
          'create_outcome_unknown',
          'm',
          true,
          50,
        );
      },
      async poll() {
        throw new Error('plain');
      },
    });
    const scm = remoteScm(childEnd);
    const error = await scm
      .mergePR({} as never, {} as never)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortError);
    expect(error).toMatchObject({
      category: 'transient',
      code: 'create_outcome_unknown',
      retryable: true,
      retryAfterMs: 50,
    });
    const plain = await scm.poll({} as never, null).catch((e: unknown) => e);
    expect(plain).not.toBeInstanceOf(PortError);
    expect((plain as Error).message).toBe('plain');
  });

  it('refuses unknown methods and is not a thenable', async () => {
    const { childEnd } = channelPair({});
    const scm = remoteScm(childEnd);
    expect((scm as unknown as { then?: unknown }).then).toBeUndefined();
    await expect(scm.health()).rejects.toThrow('Unknown SCM method');
  });

  it('drops the answer when the child is gone (killed mid-call)', async () => {
    let finished = false;
    const sent: unknown[] = [];
    const serve = serveScm({
      async mergePR() {
        finished = true;
        return { mergeCommitSha: 'x' };
      },
    } as unknown as ScmPort);
    serve(
      { type: 'scm-call', id: 1, method: 'mergePR', args: [] },
      { connected: false, send: (m: unknown) => sent.push(m) },
    );
    await new Promise((r) => setTimeout(r, 0));
    // The stand-in still completed the merge: its state outlives the child.
    expect(finished).toBe(true);
    expect(sent).toEqual([]);
  });
});
