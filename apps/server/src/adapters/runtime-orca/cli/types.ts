import type { z } from 'zod';
import type { CommandKind } from '../coordinator-identity/index.js';
export type CliPriority =
  'mutate' | 'consume' | 'identity' | 'worker-list' | 'worker-read';
export interface RunOptions {
  kind: CommandKind;
  run?: string;
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
