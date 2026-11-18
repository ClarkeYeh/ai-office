import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CommandResult } from '@ai-office/contracts/events';
import type { RepoRuntimeRef } from '../../../ports/refs.js';
import { PortError } from '../../../ports/errors.js';
import type { IdGen, Logger } from '../../../ports/services.js';
import type { OrcaCli, RunOptions } from '../cli/types.js';
import type { ShimCoordinatorIdentity } from '../coordinator-identity/shim.js';
import type { GitCli } from '../git/index.js';
import type { DispatchLedger } from '../ledger.js';
import type { AdapterState } from '../state.js';
import { contractMismatch, guard } from '../errors.js';

export interface MethodOptions {
  cli: OrcaCli;
  git: GitCli;
  identity: Pick<
    ShimCoordinatorIdentity,
    | 'ensure'
    | 'withIdentity'
    | 'track'
    | 'reclaimSession'
    | 'health'
    | 'checkOwnership'
  >;
  ledger: DispatchLedger;
  state: AdapterState;
  ids: Pick<IdGen, 'orcaRequestId'>;
  logger: Pick<Logger, 'info'>;
  dataDir: string;
}
export const object = z.record(z.string(), z.unknown());
export const text = z.string().min(1);
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = schema.safeParse(input);
  if (!value.success) throw contractMismatch();
  return value.data;
}
export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const marker = (id: string) => {
  if (!id || /\s/.test(id)) throw guard('invalid_command_marker');
  return `aio:${id}`;
};
export const hasMarker = (value: string, id: string) =>
  value.split(/\s+/).includes(marker(id));
export const transient = (code: string) =>
  new PortError(
    'transient',
    code,
    'Runtime outcome needs reconciliation',
    true,
  );
export class Context {
  constructor(readonly options: MethodOptions) {}
  async call<T>(
    args: string[],
    schema: z.ZodType<T>,
    run?: string,
    commandId?: string,
    mailbox: boolean | string = false,
  ): Promise<T> {
    const mutate =
      commandId !== undefined ||
      (args[0] === 'worktree' && ['create', 'rm'].includes(args[1]!));
    const opts: RunOptions = {
      kind: mutate ? 'mutate' : 'read',
      priority: mutate ? 'mutate' : 'worker-list',
      ...(run ? { run } : {}),
      ...(commandId
        ? { requestId: this.options.ids.orcaRequestId(commandId) }
        : {}),
      ...(mailbox && run
        ? {
            mailbox:
              typeof mailbox === 'string'
                ? { kind: 'dispatch' as const, id: mailbox }
                : { kind: 'run' as const, id: run },
          }
        : {}),
    };
    return this.options.identity
      .withIdentity(run, async () => {
        if (mutate) {
          await this.options.identity.ensure();
          if (
            run &&
            (await this.options.identity.checkOwnership(run)) === 'hijacked'
          )
            throw new PortError(
              'hijacked',
              'consumer_fenced',
              'Runtime session ownership changed',
            );
        }
        const response = await this.options.cli.run(args, opts, schema);
        return parse(schema, response.result);
      })
      .catch((error) => {
        if (
          error instanceof PortError &&
          ['outcome_unknown', 'release_unknown'].includes(error.code)
        )
          throw transient(error.code);
        throw error;
      });
  }
  check(commandId: string, input: unknown): void {
    const key = `orca:input:${commandId}`,
      fingerprint = digest(input);
    const prior = this.options.state.read(key);
    if (prior !== null && prior !== fingerprint)
      throw new PortError('bug', 'request_mismatch', 'Command input changed');
    this.options.state.write(key, fingerprint);
  }
  save(commandId: string, result: CommandResult): void {
    this.options.state.write(`orca:result:${commandId}`, result);
  }
  sessions(): Record<string, RepoRuntimeRef> {
    return parse(
      z.record(z.string(), z.object({ orcaRepoId: text, localPath: text })),
      this.options.state.read('orca:sessions') ?? {},
    );
  }
  session(run: string, repo: RepoRuntimeRef): void {
    this.options.state.write('orca:sessions', {
      ...this.sessions(),
      [run]: repo,
    });
  }
}
