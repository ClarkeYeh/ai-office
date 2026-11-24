import { describe, expect, it, vi } from 'vitest';
import { PauseGate } from './pause.js';

const settled = async (promise: Promise<unknown>) => {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  return done;
};

function target() {
  return {
    createIssue: vi.fn(async (..._args: unknown[]) => ({
      number: 7,
      url: 'u',
    })),
    mergePR: vi.fn(async (..._args: unknown[]) => ({
      mergeCommitSha: 'c'.repeat(40),
    })),
    getPR: vi.fn(async () => ({ state: 'open' })),
  };
}

describe('PauseGate (M5-T11 exact windows)', () => {
  it('withholds the first succeeded createIssue (P1) after the external call ran', async () => {
    const scm = target();
    const gate = new PauseGate({ isWindowPr: async () => true });
    const wrapped = gate.wrap(scm);
    const first = wrapped.createIssue('repo', {}, { commandId: 'cmd-1' });
    expect(await settled(first)).toBe(false);
    expect(scm.createIssue).toHaveBeenCalledTimes(1);
    expect(gate.hits).toEqual([
      { window: 'P1', method: 'createIssue', commandId: 'cmd-1' },
    ]);
    // P1 fires once: later creates answer normally.
    await expect(
      wrapped.createIssue('repo', {}, { commandId: 'cmd-2' }),
    ).resolves.toEqual({ number: 7, url: 'u' });
    expect(gate.hits).toHaveLength(1);
  });

  it('never withholds a failed call', async () => {
    const scm = target();
    scm.createIssue.mockRejectedValueOnce(new Error('down'));
    const gate = new PauseGate({ isWindowPr: async () => true });
    await expect(
      gate.wrap(scm).createIssue('repo', {}, { commandId: 'x' }),
    ).rejects.toThrow('down');
    expect(gate.hits).toEqual([]);
  });

  it('withholds P2 only after P1, only for a window PR, and only once', async () => {
    const scm = target();
    const windowPrs = new Set([12]);
    const gate = new PauseGate({
      isWindowPr: async (pr) => windowPrs.has(pr),
    });
    const wrapped = gate.wrap(scm);
    const head = 'a'.repeat(40);
    // Before P1: merges pass through even for a window PR.
    await expect(
      wrapped.mergePR({ number: 12 }, { expectedHeadSha: head }),
    ).resolves.toEqual({ mergeCommitSha: 'c'.repeat(40) });
    void wrapped.createIssue('repo', {}, { commandId: 'c1' });
    await new Promise((resolve) => setTimeout(resolve, 1));
    // Not a window PR (core): passes through.
    await expect(
      wrapped.mergePR({ number: 11 }, { expectedHeadSha: head }),
    ).resolves.toBeDefined();
    const p2 = wrapped.mergePR({ number: 12 }, { expectedHeadSha: head });
    expect(await settled(p2)).toBe(false);
    expect(gate.hits.at(-1)).toEqual({
      window: 'P2',
      method: 'mergePR',
      pr: 12,
      mergeCommitSha: 'c'.repeat(40),
      headSha: head,
    });
    await expect(
      wrapped.mergePR({ number: 12 }, { expectedHeadSha: head }),
    ).resolves.toBeDefined();
    expect(gate.hits.map((h) => h.window)).toEqual(['P1', 'P2']);
  });

  it('passes other methods and properties through', async () => {
    const scm = { ...target(), name: 'scm' };
    const wrapped = new PauseGate({ isWindowPr: async () => true }).wrap(scm);
    await expect(wrapped.getPR()).resolves.toEqual({ state: 'open' });
    expect(wrapped.name).toBe('scm');
  });
});
