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
  constructor(readonly pid: number) {
    super(`AI Office is already running (pid ${pid})`);
  }
}
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

function readLockInfo(path: string): Omit<RuntimeInfo, 'port'> {
  const text = readFileSync(path, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      'Invalid instance lock; inspect data/.lock before retrying',
    );
  }
  const result = LockInfoSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      'Invalid instance lock; inspect data/.lock before retrying',
    );
  return result.data;
}

export function acquireInstanceLock(dataDir: string): InstanceLock {
  mkdirSync(`${dataDir}/data`, { recursive: true, mode: 0o700 });
  const path = `${dataDir}/data/.lock`;
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
        if (isAlive(existing.pid)) throw new InstanceLockedError(existing.pid);
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
      if (ownsLock()) unlinkSync(path);
      released = true;
    },
  };
}
