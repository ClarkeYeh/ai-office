import { describe, expect, it } from 'vitest';
import {
  RESTART_BUDGET,
  RestartControl,
  RestartExitTimeout,
  RestartRefused,
  RestartTrigger,
  type ControlledBackend,
  type ProcessOps,
} from './restart.js';

let seq = 0;
const ev = (type: string, payload: object, extra: object = {}) => ({
  seq: ++seq,
  type,
  payload,
  ...extra,
});
const queued = (itemKey: string, pr: number) =>
  ev('workitem.merge_queued', { itemKey, pr, attemptId: 'a', headSha: 'f' });
const merge = (pr: number) =>
  ev('command.issued', {
    commandId: `c${seq}`,
    kind: 'scm.mergePR',
    args: { pr: { number: pr } },
  });
const dispatched = (itemKey: string, attemptId: string) =>
  ev('workitem.dispatched', { itemKey, attemptId });
const spawn = (attemptId: string) =>
  ev(
    'command.issued',
    { commandId: `c${seq}`, kind: 'runtime.spawnAgent' },
    { attemptId },
  );

describe('RestartTrigger (K / K′, exactly once)', () => {
  it('fires K at the first mergePR of a mul or sub PR, unconditionally', () => {
    const t = new RestartTrigger();
    expect(t.observe(queued('core', 1))).toBeUndefined();
    expect(t.observe(merge(1))).toBeUndefined(); // core: not a trigger
    t.observe(queued('mul', 2));
    t.observe(queued('sub', 3));
    const k = merge(3);
    expect(t.observe(k)).toBe('K');
    expect(t.fired).toEqual({ trigger: 'K', seq: k.seq });
    expect(t.observe(merge(2))).toBeUndefined(); // never twice
  });

  it('fires K′ at the docs spawn only while K has not fired', () => {
    const t = new RestartTrigger();
    t.observe(dispatched('name', 'a-name'));
    expect(t.observe(spawn('a-name'))).toBeUndefined();
    t.observe(dispatched('docs', 'a-docs'));
    expect(t.observe(spawn('a-docs'))).toBe("K'");
    t.observe(queued('mul', 2));
    expect(t.observe(merge(2))).toBeUndefined(); // K after K′: still one kill
  });

  it('does not fire K′ after K', () => {
    const t = new RestartTrigger();
    t.observe(queued('sub', 5));
    expect(t.observe(merge(5))).toBe('K');
    t.observe(dispatched('docs', 'd'));
    expect(t.observe(spawn('d'))).toBeUndefined();
  });

  it('ignores replays of the same seq (SSE + polling fallback)', () => {
    const t = new RestartTrigger();
    const q = queued('mul', 9);
    const m = merge(9);
    // The merge arrives first on one path, then both are replayed.
    expect(t.observe(m)).toBeUndefined();
    t.observe(q);
    expect(t.observe(m)).toBeUndefined(); // same seq: counted once
    expect(t.fired).toBeUndefined();
    expect(t.observe(merge(9))).toBe('K'); // a new mergePR (new seq) for it
  });

  it('maps attempts from seat.spawned too', () => {
    const t = new RestartTrigger();
    t.observe(ev('seat.spawned', { itemKey: 'docs', attemptId: 's1' }));
    expect(t.observe(spawn('s1'))).toBe("K'");
  });
});

/** A fake world of processes: nothing real is ever signalled. */
function world() {
  const live = new Set<number>();
  const signals: { pid: number; signal: string }[] = [];
  let runtime: number | undefined;
  let clock = 1_000;
  let nextPid = 500;
  const exits = new Map<number, () => void>();
  const ops: ProcessOps = {
    runtimePid: async () => runtime,
    kill(pid, signal) {
      signals.push({ pid, signal });
      live.delete(pid);
      if (runtime === pid) runtime = undefined;
      exits.get(pid)?.();
    },
    alive: (pid) => live.has(pid),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  const starts: number[] = [];
  const start = async (): Promise<ControlledBackend> => {
    const pid = nextPid++;
    live.add(pid);
    starts.push(pid);
    clock += 1_500; // startup takes 1.5 s
    runtime = pid;
    let exited!: () => void;
    const done = new Promise<void>((r) => (exited = r));
    exits.set(pid, exited);
    return {
      pid,
      url: 'http://127.0.0.1:41234',
      bootstrapUrl: 'http://127.0.0.1:41234/auth/bootstrap?code=x',
      exited: done,
      stop: async () => {
        live.delete(pid);
        exited();
      },
    };
  };
  return {
    ops,
    start,
    signals,
    starts,
    live,
    setRuntime: (pid: number | undefined) => (runtime = pid),
  };
}

describe('RestartControl (fake processes)', () => {
  it('kills exactly the started runtime.json holder once and restarts', async () => {
    const w = world();
    const control = new RestartControl({
      home: '/isolated/home',
      start: w.start,
      ops: w.ops,
    });
    const first = await control.start();
    const record = await control.killAndRestart('K', 42);
    expect(w.signals).toEqual([{ pid: first.pid, signal: 'SIGKILL' }]);
    expect(w.starts).toHaveLength(2);
    expect(record).toMatchObject({
      trigger: 'K',
      triggerSeq: 42,
      oldPid: first.pid,
      newPid: w.starts[1],
      oldPidAliveAfter: false,
      runtimePidAfter: w.starts[1],
      withinBudget: true,
    });
    expect(record.downtimeMs).toBe(record.restartIssuedMs + record.readyMs);
    expect(control.backend.pid).toBe(w.starts[1]);
    expect(control.pids).toEqual(w.starts);
  });

  it('refuses a second kill: K and K′ total exactly one', async () => {
    const w = world();
    const control = new RestartControl({
      home: '/h',
      start: w.start,
      ops: w.ops,
    });
    await control.start();
    await control.killAndRestart('K', 1);
    await expect(control.killAndRestart("K'", 2)).rejects.toBeInstanceOf(
      RestartRefused,
    );
    expect(w.signals).toHaveLength(1);
  });

  it('never signals a pid that differs from runtime.json', async () => {
    const w = world();
    const control = new RestartControl({
      home: '/h',
      start: w.start,
      ops: w.ops,
    });
    await control.start();
    w.setRuntime(4242); // someone else holds the lock
    await expect(control.killAndRestart('K', 1)).rejects.toThrow(
      'runtime.json pid differs',
    );
    w.setRuntime(undefined);
    await expect(control.killAndRestart('K', 1)).rejects.toThrow(
      RestartRefused,
    );
    expect(w.signals).toEqual([]);
    // A refusal does not consume the one kill.
    expect(control.hasKilled).toBe(false);
  });

  it('never signals the harness itself', async () => {
    const w = world();
    const control = new RestartControl({
      home: '/h',
      start: async () => ({
        ...(await w.start()),
        pid: process.pid,
      }),
      ops: { ...w.ops, runtimePid: async () => process.pid },
    });
    await control.start();
    await expect(control.killAndRestart('K', 1)).rejects.toThrow(
      'Refusing to signal the harness',
    );
    expect(w.signals).toEqual([]);
  });

  it('refuses a backend without a valid pid', async () => {
    const control = new RestartControl({
      home: '/h',
      start: async () =>
        ({
          pid: 1,
          exited: Promise.resolve(),
          stop: async () => undefined,
        }) as never,
      ops: world().ops,
    });
    await expect(control.start()).rejects.toBeInstanceOf(RestartRefused);
  });

  it('waits until the new process owns runtime.json and reports the budget', async () => {
    const w = world();
    let slow = 0;
    const control = new RestartControl({
      home: '/h',
      start: async () => {
        const b = await w.start();
        if (w.starts.length === 2) w.setRuntime(undefined); // not written yet
        return b;
      },
      ops: {
        ...w.ops,
        runtimePid: async () => {
          if (w.starts.length === 2 && slow++ === 3) w.setRuntime(w.starts[1]);
          return w.ops.runtimePid('/h');
        },
        sleep: async (ms) => w.ops.sleep(ms * 100), // 25 s per poll
      },
    });
    await control.start();
    const record = await control.killAndRestart('K', 1);
    expect(record.readyMs).toBeGreaterThan(RESTART_BUDGET.readyWithinMs);
    expect(record.withinBudget).toBe(false);
  });

  it('fails loudly when the killed backend never exits, and stop() still reaps it', async () => {
    const w = world();
    let stopped = 0;
    const control = new RestartControl({
      home: '/h',
      start: async () => ({
        ...(await w.start()),
        exited: new Promise(() => undefined), // survives SIGKILL
        stop: async () => {
          stopped++;
        },
      }),
      ops: w.ops,
      exitTimeoutMs: 20,
    });
    const first = await control.start();
    await expect(control.killAndRestart('K', 1)).rejects.toBeInstanceOf(
      RestartExitTimeout,
    );
    expect(w.starts).toEqual([first.pid]); // no restart on top of a survivor
    expect(control.hasKilled).toBe(true); // and never a second kill
    await control.stop();
    expect(stopped).toBe(1);
  });

  it('stop() stops the current backend; start() twice is refused', async () => {
    const w = world();
    const control = new RestartControl({
      home: '/h',
      start: w.start,
      ops: w.ops,
    });
    const b = await control.start();
    await expect(control.start()).rejects.toThrow('already started');
    await control.stop();
    expect(w.live.has(b.pid)).toBe(false);
    expect(() => control.backend).toThrow('not started');
  });
});
