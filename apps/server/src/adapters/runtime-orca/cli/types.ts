import type { z } from 'zod';
import type { CommandKind } from '../coordinator-identity/index.js';
/**
 * `mutate`, `consume`, `worker-list` and `identity` are the latency-critical
 * lane (send and answer, long poll and mail, the one status list, the shim
 * and ownership checks every pass awaits); `worker-read` and `bulk` (probes,
 * task-list, worktree show, other reads) are the bulk lane, which yields when
 * the budget is tight (FX-CLI-BUDGET, FX-TAIL).
 */
export type CliPriority =
  'mutate' | 'consume' | 'worker-list' | 'identity' | 'worker-read' | 'bulk';
export interface RunOptions {
  kind: CommandKind;
  run?: string;
  mailbox?: { kind: 'run' | 'dispatch'; id: string };
  /** Target of native `terminal show|read|close`; argsFor decides whether it is allowed. */
  terminal?: string;
  priority: CliPriority;
  requestId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface ParsedResult<T = Record<string, unknown>> {
  result: T;
  exitCode: number | null;
}
/** Replay/record implementations use the same boundary as production. */
export interface OrcaCli {
  run<T = Record<string, unknown>>(
    args: readonly string[],
    options: RunOptions,
    schema?: z.ZodType<T>,
  ): Promise<ParsedResult<T>>;
}
export interface ExecRequest {
  bin: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface ExecResult {
  stdout: string;
  exitCode: number | null;
}
export interface Exec {
  run(request: ExecRequest): Promise<ExecResult>;
}
