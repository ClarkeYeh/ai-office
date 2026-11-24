/**
 * M5-T7 restart control (M5_PLAN §2.3, J2): exactly one `kill -9` per run of
 * the AI Office backend server process the harness itself started, then a
 * restart on the same home and port. The trigger (K / K′) is a pure state
 * machine over domain events; the control takes its process operations by
 * injection, so CI pins it with fake processes (never the wrong pid, K/K′
 * exactly once in total). No `pkill`, no name matching, never Orca, the
 * terminal-host daemon, an agent or the harness itself.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RESTART_TRIGGERS } from './scenario/index.js';
import type { Json } from '../orca/t17/checks.js';

export type TriggerName = 'K' | "K'";

/** §2.3.3 downtime budget. */
export const RESTART_BUDGET = {
  /** Kill → restart issued. */
  restartWithinMs: 5_000,
  /** Restart issued → ready (new pid in runtime.json, reconcile done). */
  readyWithinMs: 60_000,
  /** Kill → ready. */
  downtimeMaxMs: 90_000,
} as const;

/**
 * K: the first `command.issued{scm.mergePR}` for a `mul` or `sub` PR fires an
 * unconditional kill (live agents are only recorded). K′: the `docs` spawn,
 * only while K has not fired. Whatever fires first wins; nothing fires twice.
 * PR → item comes from `workitem.merge_queued`; attempt → item from
 * `workitem.dispatched` / `seat.spawned`.
 */
export class RestartTrigger {
  private readonly prItem = new Map<number, string>();
  private readonly attemptItem = new Map<string, string>();
  private readonly seen = new Set<number>();
  private firedAs: { trigger: TriggerName; seq: number } | undefined;

  get fired(): { trigger: TriggerName; seq: number } | undefined {
    return this.firedAs;
  }

  /** Feeds one domain event (any order of replays; each seq counts once). */
  observe(event: Json): TriggerName | undefined {
    const seq = Number(event.seq);
    if (Number.isSafeInteger(seq)) {
      if (this.seen.has(seq)) return undefined;
      this.seen.add(seq);
    }
    const p = (event.payload ?? {}) as Json;
    if (event.type === 'workitem.merge_queued')
      this.prItem.set(Number(p.pr), String(p.itemKey));
    if (
      (event.type === 'workitem.dispatched' || event.type === 'seat.spawned') &&
      p.itemKey !== undefined
    )
      this.attemptItem.set(String(p.attemptId), String(p.itemKey));
    if (this.firedAs || event.type !== 'command.issued') return undefined;
    const { primary, fallback } = RESTART_TRIGGERS;
    if (p.kind === primary.commandKind) {
      const item = this.prItem.get(Number(p.args?.pr?.number));
      if (item && (primary.itemKeys as readonly string[]).includes(item))
        return this.fire('K', seq);
    }
    if (p.kind === fallback.commandKind) {
      const item = this.attemptItem.get(String(event.attemptId));
      if (item && (fallback.itemKeys as readonly string[]).includes(item))
        return this.fire("K'", seq);
    }
    return undefined;
  }

  private fire(trigger: TriggerName, seq: number): TriggerName {
    this.firedAs = { trigger, seq };
    return trigger;
  }
}

/** A started backend as the control sees it (production CLI or dev child). */
export interface ControlledBackend {
  /** The server process pid (runtime.json's holder). */
  readonly pid: number;
  readonly url: string;
  readonly bootstrapUrl: string;
  /** Resolves once the server process is gone. */
  readonly exited: Promise<unknown>;
  stop(): Promise<unknown>;
}

/** Process operations, injected so CI never signals a real process. */
export interface ProcessOps {
  /** `runtime.json` → pid, or undefined while absent. */
  runtimePid(home: string): Promise<number | undefined>;
  kill(pid: number, signal: 'SIGKILL'): void;
  alive(pid: number): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realProcessOps: ProcessOps = {
  async runtimePid(home) {
    const text = await readFile(join(home, 'runtime.json'), 'utf8').catch(
      () => undefined,
    );
    if (!text) return undefined;
    const pid = (JSON.parse(text) as { pid?: unknown }).pid;
    return typeof pid === 'number' && Number.isSafeInteger(pid)
      ? pid
      : undefined;
  },
  kill: (pid, signal) => process.kill(pid, signal),
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  now: () => Date.now(),
  sleep: (ms) => delay(ms),
};

export interface RestartRecord {
  trigger: TriggerName;
  triggerSeq: number;
  oldPid: number;
  newPid: number;
  /** kill → restart issued. */
  restartIssuedMs: number;
  /** restart issued → ready. */
  readyMs: number;
  /** kill → ready. */
  downtimeMs: number;
  oldPidAliveAfter: boolean;
  runtimePidAfter: number | undefined;
  withinBudget: boolean;
  /** Epoch ms of readiness (releases a held escalation answer, §2.2.4). */
  readyAt: number;
}

export class RestartRefused extends Error {}

/**
 * Owns the pid ledger of backends it started and the single kill. `start`
 * relaunches on the same home and port; the control only ever signals a pid
 * that is both in its ledger and the current runtime.json holder.
 */
export class RestartControl {
  private readonly started = new Set<number>();
  private killed = false;
  private current: ControlledBackend | undefined;
  record: RestartRecord | undefined;

  constructor(
    private readonly options: {
      home: string;
      start: () => Promise<ControlledBackend>;
      ops?: ProcessOps;
      /** Polls of runtime.json while waiting for the old holder to vanish. */
      pollMs?: number;
    },
  ) {}

  private get ops(): ProcessOps {
    return this.options.ops ?? realProcessOps;
  }

  get backend(): ControlledBackend {
    if (!this.current) throw new Error('Backend not started');
    return this.current;
  }

  get pids(): readonly number[] {
    return [...this.started];
  }

  get hasKilled(): boolean {
    return this.killed;
  }

  async start(): Promise<ControlledBackend> {
    if (this.current) throw new Error('Backend already started');
    this.current = await this.launch();
    return this.current;
  }

  private async launch(): Promise<ControlledBackend> {
    const backend = await this.options.start();
    if (!Number.isSafeInteger(backend.pid) || backend.pid <= 1)
      throw new RestartRefused('Started backend has no valid pid');
    this.started.add(backend.pid);
    return backend;
  }

  /**
   * The one kill of this run, then the same-home same-port restart. Refuses
   * (before any signal) a second kill, a pid outside the ledger, a pid that
   * differs from runtime.json, or the harness's own pid.
   */
  async killAndRestart(
    trigger: TriggerName,
    triggerSeq: number,
  ): Promise<RestartRecord> {
    if (this.killed) throw new RestartRefused('Exactly one kill per run');
    const backend = this.backend;
    const runtimePid = await this.ops.runtimePid(this.options.home);
    if (runtimePid !== backend.pid)
      throw new RestartRefused('runtime.json pid differs from the started pid');
    if (!this.started.has(runtimePid))
      throw new RestartRefused('pid is not in the harness ledger');
    if (runtimePid === process.pid || runtimePid === process.ppid)
      throw new RestartRefused('Refusing to signal the harness');
    this.killed = true;
    const killedAt = this.ops.now();
    this.ops.kill(runtimePid, 'SIGKILL');
    await backend.exited;
    this.current = undefined;
    const restartAt = this.ops.now();
    const next = await this.launch();
    this.current = next;
    // Ready = the new holder is in runtime.json; the server writes it only
    // after listen, and nothing listens before reconcile finished (main.ts).
    for (;;) {
      const pid = await this.ops.runtimePid(this.options.home);
      if (pid === next.pid) break;
      if (this.ops.now() - restartAt > RESTART_BUDGET.readyWithinMs * 3)
        throw new Error('Restarted backend never owned runtime.json');
      await this.ops.sleep(this.options.pollMs ?? 250);
    }
    const readyAt = this.ops.now();
    const record: RestartRecord = {
      trigger,
      triggerSeq,
      oldPid: runtimePid,
      newPid: next.pid,
      restartIssuedMs: restartAt - killedAt,
      readyMs: readyAt - restartAt,
      downtimeMs: readyAt - killedAt,
      oldPidAliveAfter: this.ops.alive(runtimePid),
      runtimePidAfter: await this.ops.runtimePid(this.options.home),
      withinBudget:
        restartAt - killedAt <= RESTART_BUDGET.restartWithinMs &&
        readyAt - restartAt <= RESTART_BUDGET.readyWithinMs &&
        readyAt - killedAt <= RESTART_BUDGET.downtimeMaxMs,
      readyAt,
    };
    this.record = record;
    return record;
  }

  async stop(): Promise<void> {
    const backend = this.current;
    this.current = undefined;
    await backend?.stop();
  }
}
