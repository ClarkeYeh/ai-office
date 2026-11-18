import { z } from 'zod';
import { PortError } from '../../../ports/errors.js';
import type { CoordinatorIdentity } from '../coordinator-identity/index.js';
import { subprocessEnv } from '../env-allowlist.js';
import { contractMismatch, guard } from '../errors.js';
import {
  checkReceipt,
  JsonObjectSchema,
  parseResult,
} from '../schemas/index.js';
import type { CwdGuard } from './cwd.js';
import { CliMetrics, CliScheduler } from './scheduler.js';
import type { Exec, OrcaCli, ParsedResult, RunOptions } from './types.js';
export type * from './types.js';

export interface OrcaCliOptions {
  bin: string;
  env: NodeJS.ProcessEnv;
  cwdGuard: CwdGuard;
  identity: Pick<CoordinatorIdentity, 'argsFor'>;
  exec: Exec;
  scheduler?: CliScheduler;
  metrics?: CliMetrics;
}
/** No retries here: application recovery must retain the original request id. */
export class DefaultOrcaCli implements OrcaCli {
  readonly scheduler: CliScheduler;
  readonly metrics: CliMetrics;
  constructor(private readonly options: OrcaCliOptions) {
    this.scheduler = options.scheduler ?? new CliScheduler();
    this.metrics = options.metrics ?? new CliMetrics();
  }
  async run<T = Record<string, unknown>>(
    args: readonly string[],
    opts: RunOptions,
    schema?: z.ZodType<T>,
  ): Promise<ParsedResult<T>> {
    if (
      !args.length ||
      args.some((arg) =>
        /^(--from|--terminal|--run|--retry-request)(=|$)/.test(arg),
      )
    )
      throw guard('caller_identity_or_request_flag');
    if (opts.kind !== 'read' && !z.uuid().safeParse(opts.requestId).success)
      throw guard('request_id_required');
    if (opts.kind === 'consume' && !opts.run)
      throw guard('consume_run_required');
    const identity = await this.options.identity.argsFor(opts.kind, opts.run);
    if (opts.kind === 'mutate' && !identity.includes('--from'))
      throw guard('mutate_identity_required');
    if (opts.kind === 'consume' && !identity.includes('--terminal'))
      throw guard('consume_identity_required');
    const argv = [...args, ...identity];
    if (opts.run && !identity.includes('--run')) argv.push('--run', opts.run);
    if (!argv.includes('--json')) argv.push('--json');
    if (opts.kind !== 'read') {
      if (!argv.includes('--full')) argv.push('--full');
      argv.push('--retry-request', opts.requestId!);
    }
    // Discovery must finish outside the concurrency slot to avoid recursion/deadlock.
    await this.options.cwdGuard.check();
    const priority = opts.kind === 'read' ? opts.priority : opts.kind;
    return this.scheduler.schedule(priority, async () => {
      if (opts.signal?.aborted) throw guard('cli_aborted');
      const cwd = await this.options.cwdGuard.check();
      const start = Date.now();
      let failed = true;
      try {
        const output = await this.options.exec.run({
          bin: this.options.bin,
          args: argv,
          cwd,
          env: subprocessEnv(this.options.env),
          timeoutMs: opts.timeoutMs ?? 60_000,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        const result = parseResult(output.stdout);
        checkReceipt(args, result);
        const validated = (schema ?? JsonObjectSchema).safeParse(result);
        if (!validated.success) throw contractMismatch();
        failed = false;
        return { result: validated.data as T, exitCode: output.exitCode };
      } catch (error) {
        if (error instanceof PortError) throw error;
        throw new PortError(
          'transient',
          'runtime_unavailable',
          'Runtime execution failed',
          true,
        );
      } finally {
        // Only command words, never arguments or output, are metric labels.
        const label = args
          .slice(0, args[0] === 'status' ? 1 : 2)
          .map((s) => (/^[a-z-]+$/.test(s) ? s : 'other'))
          .join(' ');
        this.metrics.record(label, Date.now() - start, failed);
      }
    });
  }
}
