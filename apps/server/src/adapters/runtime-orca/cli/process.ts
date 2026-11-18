import {
  spawn,
  type SpawnOptionsWithoutStdio,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PortError } from '../../../ports/errors.js';
import { subprocessEnv } from '../env-allowlist.js';
import { guard, orcaError } from '../errors.js';
import type { AdapterState } from '../state.js';
import type { Exec, ExecRequest, ExecResult } from './types.js';

export type Spawn = (
  bin: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;
const groupsSchema = z.array(
  z.object({ pgid: z.number().int().positive(), digest: z.string() }),
);
const digest = (command: string) =>
  createHash('sha256').update(command).digest('hex');
/** Command identity is a digest, never persisted argv (which can contain a spec). */
export class ProcessGroups {
  private groups: z.infer<typeof groupsSchema>;
  constructor(private readonly state: AdapterState) {
    this.groups =
      groupsSchema.safeParse(state.read('orca:process-groups')).data ?? [];
  }
  add(pgid: number, command: string): void {
    this.groups.push({ pgid, digest: digest(command) });
    this.save();
  }
  remove(pgid: number): void {
    this.groups = this.groups.filter((g) => g.pgid !== pgid);
    this.save();
  }
  private save(): void {
    this.state.write('orca:process-groups', this.groups);
  }
  /** inspect must return `ps -o pid=,command= -g <pgid>` output. Fail closed on PID reuse. */
  async cleanup(
    inspect: (pgid: number) => Promise<string>,
    kill: (pgid: number) => void,
  ): Promise<number> {
    let killed = 0;
    for (const group of [...this.groups]) {
      let output: string;
      try {
        output = await inspect(group.pgid);
      } catch {
        continue;
      }
      const leader = output
        .split('\n')
        .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
        .find((line) => line && Number(line[1]) === group.pgid);
      if (leader && digest(leader[2]!) === group.digest) {
        try {
          kill(group.pgid);
          killed++;
        } catch {
          continue;
        }
      }
      this.remove(group.pgid);
    }
    return killed;
  }
}
export class SpawnExec implements Exec {
  constructor(
    private readonly groups: ProcessGroups,
    private readonly spawnProcess: Spawn = spawn,
    private readonly killGroup: (
      pgid: number,
      signal: NodeJS.Signals,
    ) => void = (pgid, signal) => {
      process.kill(-pgid, signal);
    },
    private readonly maxOutputBytes = 16 * 1024 * 1024,
  ) {}
  run(request: ExecRequest): Promise<ExecResult> {
    if (request.signal?.aborted) return Promise.reject(guard('cli_aborted'));
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(request.bin, request.args, {
          cwd: request.cwd,
          env: request.env,
          detached: true,
          shell: false,
        });
      } catch {
        reject(orcaError('runtime_unavailable'));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: PortError | undefined;
      let finished = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (error: PortError) => {
        if (failure || finished) return;
        failure = error;
        if (child.pid) {
          try {
            this.killGroup(child.pid, 'SIGTERM');
          } catch {
            /* already exited */
          }
          killTimer = setTimeout(() => {
            if (child.pid) {
              try {
                this.killGroup(child.pid, 'SIGKILL');
              } catch {
                /* already exited */
              }
            }
          }, 1000);
        }
      };
      const abort = () => stop(guard('cli_aborted'));
      const timer = setTimeout(
        () => stop(orcaError('ETIMEDOUT')),
        request.timeoutMs,
      );
      request.signal?.addEventListener('abort', abort, { once: true });
      child.on('spawn', () => {
        if (child.pid) {
          try {
            this.groups.add(
              child.pid,
              [request.bin, ...request.args].join(' '),
            );
          } catch {
            stop(guard('process_state_unavailable'));
          }
        }
      });
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > this.maxOutputBytes) stop(guard('cli_output_limit'));
        else chunks.push(chunk);
      });
      // Drain stderr without retaining transcript/keepalive text or mixing it into JSON.
      child.stderr.on('data', () => {});
      child.stdin.end();
      child.on('error', () => {
        failure ??= orcaError('runtime_unavailable');
      });
      child.on('close', (exitCode) => {
        finished = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        request.signal?.removeEventListener('abort', abort);
        if (child.pid) {
          try {
            this.groups.remove(child.pid);
          } catch {
            failure ??= guard('process_state_unavailable');
          }
        }
        if (failure) reject(failure);
        else
          resolve({ stdout: Buffer.concat(chunks).toString('utf8'), exitCode });
      });
    });
  }
}

/** Production startup hook; keeping ps/kill here preserves subprocess placement. */
export async function cleanupOrphanProcesses(
  groups: ProcessGroups,
  options: {
    exec: Exec;
    cwdGuard: import('./cwd.js').CwdGuard;
    env: NodeJS.ProcessEnv;
    kill?: (pgid: number) => void;
  },
): Promise<number> {
  const cwd = await options.cwdGuard.check();
  return groups.cleanup(
    async (pgid) => {
      const result = await options.exec.run({
        bin: '/bin/ps',
        args: ['-o', 'pid=,command=', '-g', String(pgid)],
        cwd,
        env: subprocessEnv(options.env),
        timeoutMs: 5000,
      });
      if (result.exitCode !== 0 && result.exitCode !== 1)
        throw guard('process_inspection_failed');
      return result.stdout;
    },
    options.kill ??
      ((pgid) => {
        process.kill(-pgid, 'SIGTERM');
      }),
  );
}
