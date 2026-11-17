import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  RuntimeInfoSchema,
  type RuntimeInfo,
} from '@ai-office/contracts/agent-submission';
import { hasCode } from './settings.js';

export type { RuntimeInfo } from '@ai-office/contracts/agent-submission';
const LockInfoSchema = RuntimeInfoSchema.omit({ port: true }).strict();

export class InstanceLockedError extends Error {
  constructor(
    readonly pid: number,
    readonly startedAt?: string,
  ) {
    super(
      `AI Office is already running (pid ${pid}${startedAt === undefined ? '' : `, started ${startedAt}`}); if that process is gone, restart with --break-lock`,
    );
  }
}
export interface AcquireOptions {
  /** §16 risk 11: the user confirmed the recorded pid is not AI Office. */
  breakLock?: boolean;
}
/** Locks held by this process: a pid match alone cannot tell them from stale ones. */
const held = new Set<string>();
export interface InstanceLock {
  readonly pid: number;
  readonly startedAt: string;
  writeRuntime(port: number): RuntimeInfo;
  release(): void;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasCode(error, 'ESRCH')) return false;
    if (hasCode(error, 'EPERM')) return true;
    throw error;
  }
}

function parseLockInfo(text: string): Omit<RuntimeInfo, 'port'> | null {
  try {
    const result = LockInfoSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** The holder creates the file before writing it: retry briefly before failing closed. */
function readLockInfo(path: string): Omit<RuntimeInfo, 'port'> {
  for (let attempt = 0; ; attempt++) {
    const info = parseLockInfo(readFileSync(path, 'utf8'));
    if (info !== null) return info;
    if (attempt >= 10)
      throw new Error(
        'Invalid instance lock contents; if no AI Office process is running, restart with --break-lock',
      );
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

export function acquireInstanceLock(
  dataDir: string,
  options: AcquireOptions = {},
): InstanceLock {
  mkdirSync(`${dataDir}/data`, { recursive: true, mode: 0o700 });
  const path = `${dataDir}/data/.lock`;
  if (held.has(path)) {
    const existing = parseLockInfo(readFileSync(path, 'utf8'));
    throw new InstanceLockedError(process.pid, existing?.startedAt);
  }
  if (options.breakLock) {
    rmSync(path, { force: true });
    rmSync(`${path}.reclaim`, { force: true });
  }
  const info = { pid: process.pid, startedAt: new Date().toISOString() };
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
    // Serialize stale recovery. A crashed recovery leaves this guard for manual
    // inspection, failing closed instead of risking two live owners.
    const guardPath = `${path}.reclaim`;
    let guard: number;
    try {
      guard = openSync(guardPath, 'wx', 0o600);
    } catch {
      throw new Error(
        'Instance lock recovery in progress; inspect data/.lock.reclaim if it persists',
      );
    }
    try {
      try {
        const existing = readLockInfo(path);
        // PID reuse can conservatively reject startup; accepted residual risk (Q13).
        // Our own pid is never a live holder here (held locks were rejected above):
        // a container restart reuses pid 1 for the next process.
        if (existing.pid !== process.pid && isAlive(existing.pid))
          throw new InstanceLockedError(existing.pid, existing.startedAt);
        unlinkSync(path);
      } catch (readError) {
        if (!hasCode(readError, 'ENOENT')) throw readError;
      }
      fd = openSync(path, 'wx', 0o600);
    } finally {
      closeSync(guard);
      unlinkSync(guardPath);
    }
  }
  try {
    writeFileSync(fd, JSON.stringify(info));
  } catch (error) {
    closeSync(fd);
    unlinkSync(path);
    throw error;
  }
  const identity = fstatSync(fd);
  closeSync(fd);
  held.add(path);
  let released = false;
  function ownsLock(): boolean {
    if (released) return false;
    try {
      const current = statSync(path);
      return (
        current.dev === identity.dev &&
        current.ino === identity.ino &&
        readFileSync(path, 'utf8') === JSON.stringify(info)
      );
    } catch {
      return false;
    }
  }
  return {
    ...info,
    writeRuntime(port) {
      if (!ownsLock())
        throw new Error('Only the instance lock holder may write runtime.json');
      const runtime = RuntimeInfoSchema.parse({ ...info, port });
      const temporary = `${dataDir}/.runtime-${info.pid}.tmp`;
      const output = openSync(temporary, 'wx', 0o600);
      try {
        try {
          writeFileSync(output, JSON.stringify(runtime));
        } finally {
          closeSync(output);
        }
        renameSync(temporary, `${dataDir}/runtime.json`);
      } finally {
        rmSync(temporary, { force: true });
      }
      return runtime;
    },
    release() {
      if (ownsLock()) {
        // runtime.json without a live holder would point the CLI at a dead port.
        const runtimePath = `${dataDir}/runtime.json`;
        try {
          const runtime = RuntimeInfoSchema.safeParse(
            JSON.parse(readFileSync(runtimePath, 'utf8')),
          );
          if (
            runtime.success &&
            runtime.data.pid === info.pid &&
            runtime.data.startedAt === info.startedAt
          )
            rmSync(runtimePath, { force: true });
        } catch {
          /* Missing or foreign runtime.json is left alone. */
        }
        unlinkSync(path);
      }
      if (!released) held.delete(path);
      released = true;
    },
  };
}
