import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { PortError } from '../../../ports/errors.js';
import type { RuntimeHealth } from '../../../ports/runtime.js';
import type { RuntimeEvent } from '../../../ports/runtime-events.js';
import type { OrcaCli } from '../cli/types.js';
import { guard } from '../errors.js';
import type { AdapterState } from '../state.js';
import type {
  CommandKind,
  CoordinatorIdentity,
  IdentityContext,
  IdentityStatus,
  ThrottleOptions,
} from './index.js';

const STATE_KEY = 'orca:shim';
const THROTTLE_MS = 30_000;
const HANDLE = /^term_[A-Za-z0-9-]{1,128}$/;
const TerminalSchema = z.looseObject({
  handle: z.string().regex(HANDLE),
  title: z.string().nullish(),
  incarnationId: z.string().nullish(),
  createdAt: z.union([z.string(), z.number()]).nullish(),
});
const TerminalListSchema = z.looseObject({
  terminals: z.array(TerminalSchema),
});
const TerminalCreateSchema = z.looseObject({ terminal: TerminalSchema });
const RepoListSchema = z.looseObject({
  repos: z.array(z.looseObject({ path: z.string() })),
});
const RunOwnerSchema = z.looseObject({
  run: z.looseObject({
    id: z.string(),
    coordinator_handle: z.string().nullish(),
    consumer_generation: z.number().int().nonnegative(),
  }),
});
const RunRecordSchema = z.object({
  handle: z.string(),
  generation: z.number().int().nonnegative(),
  hijacked: z.boolean().default(false),
});
const StateSchema = z.object({
  v: z.literal(1),
  handle: z.string().regex(HANDLE).nullable(),
  incarnationId: z.string().nullable(),
  location: z.string().nullable(),
  /** Shims this backend created or adopted; only runs bound to one are rebound. */
  history: z.array(z.string()).default([]),
  runs: z.record(z.string(), RunRecordSchema),
});
type State = z.infer<typeof StateSchema>;
type Terminal = z.infer<typeof TerminalSchema>;
type RunOwner = z.infer<typeof RunOwnerSchema>['run'];

export interface ShimIdentityOptions {
  cli: OrcaCli;
  state: AdapterState;
  dataDir: string;
  shimLocation: 'folder-workspace' | 'repo-main-worktree';
  /** The workflow repository's main worktree: the explicit fallback location. */
  repoMainWorktree?: string;
  closeOnExit?: boolean;
  now?: () => number;
}
export type IdentityHealth = Pick<
  RuntimeHealth,
  'shim' | 'shimLocation' | 'ownership' | 'warnings'
>;
/** Title marker: stable per backend data directory, never the path itself. */
export function shimMarker(dataDir: string): string {
  return `aio-shim:${createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 12)}`;
}
const newest = (terminals: Terminal[]): Terminal | undefined =>
  terminals.reduce<Terminal | undefined>((best, terminal) => {
    if (!best) return terminal;
    const a = Date.parse(String(best.createdAt ?? ''));
    const b = Date.parse(String(terminal.createdAt ?? ''));
    // Without timestamps, Orca's listing order (later = newer) decides.
    return Number.isNaN(a) || Number.isNaN(b) || b >= a ? terminal : best;
  }, undefined);

/**
 * SPEC §6.2 F2 shim. Day-1 P2a: an app restart keeps the handle and its
 * incarnation, so a listed handle with an unchanged incarnation is reused and
 * nothing is rebound. Titles may read null after a restart: identify our shim
 * by the stored handle; titles only find shims when no stored handle is live.
 */
export class ShimCoordinatorIdentity implements CoordinatorIdentity {
  readonly mode = 'F2-shim-terminal';
  private readonly marker: string;
  private readonly now: () => number;
  private readonly closable = new Set<string>();
  private readonly checkedAt = new Map<string, number>();
  private readonly events: RuntimeEvent[] = [];
  private ensuredAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<IdentityStatus> | undefined;
  private location: string | undefined;
  private fallback = false;
  private live = false;
  constructor(private readonly options: ShimIdentityOptions) {
    this.marker = shimMarker(options.dataDir);
    this.now = options.now ?? Date.now;
  }

  async argsFor(
    kind: CommandKind,
    run?: string,
    context?: IdentityContext,
  ): Promise<string[]> {
    const [group, verb] = context?.command ?? ['orchestration'];
    if (
      group === 'terminal' &&
      ['show', 'read', 'close'].includes(verb ?? '')
    ) {
      const target =
        context?.terminal ??
        (verb === 'close' ? undefined : (this.load().handle ?? undefined));
      if (!target || !HANDLE.test(target))
        throw guard('terminal_target_required');
      // Only shims this class identified by title (or its own on exit) may close.
      if (verb === 'close' && !this.closable.has(target))
        throw guard('terminal_close_not_permitted');
      return ['--terminal', target];
    }
    if (group !== 'orchestration') return [];
    if (kind === 'read') {
      const mailbox = context?.mailbox;
      return verb === 'inbox' && mailbox
        ? ['--terminal', `${mailbox.kind}:${mailbox.id}`]
        : [];
    }
    const handle = await this.handle();
    if (kind === 'mutate') return ['--from', handle];
    if (!run) throw guard('consume_run_required');
    return ['--terminal', handle, '--run', run];
  }

  /** Throttled to once per 30 s unless forced; concurrent callers share one pass. */
  ensure(options: ThrottleOptions = {}): Promise<IdentityStatus> {
    if (this.inflight) return this.inflight;
    const handle = this.load().handle;
    if (!options.force && handle && this.now() - this.ensuredAt < THROTTLE_MS)
      return Promise.resolve({ handle, restored: false });
    this.inflight = this.ensureNow().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** Detects only; a hijacked run is never taken back automatically. */
  async checkOwnership(
    run: string,
    options: ThrottleOptions = {},
  ): Promise<'owned' | 'hijacked'> {
    const record = this.load().runs[run];
    const last = this.checkedAt.get(run);
    if (
      !options.force &&
      last !== undefined &&
      this.now() - last < THROTTLE_MS &&
      record
    )
      return record.hijacked ? 'hijacked' : 'owned';
    this.checkedAt.set(run, this.now());
    const owner = await this.show(run);
    const state = this.load();
    const current = state.runs[run];
    const ours =
      owner.coordinator_handle === state.handle &&
      (!current || current.generation === owner.consumer_generation);
    if (ours) {
      this.record(run, owner, false);
      return 'owned';
    }
    if (!current?.hijacked || current.generation !== owner.consumer_generation)
      this.events.push({
        type: 'runtime.identity_hijacked',
        externalKey: `orca:identity_hijacked:${run}:${owner.consumer_generation}`,
        occurredAt: new Date(this.now()).toISOString(),
        run,
        coordinatorHandle: owner.coordinator_handle ?? '',
        consumerGeneration: owner.consumer_generation,
      });
    // Keep the last owned generation; the flag alone marks the hijack.
    this.save({
      ...state,
      runs: {
        ...state.runs,
        [run]: {
          handle: current?.handle ?? owner.coordinator_handle ?? '',
          generation: owner.consumer_generation,
          hijacked: true,
        },
      },
    });
    return 'hijacked';
  }

  /** Exception-gate "reclaim and continue". Idempotent: an owned run is not rebound. */
  async reclaimSession(run: string): Promise<{ reclaimed: boolean }> {
    const handle = await this.handle();
    const owner = await this.show(run);
    if (owner.coordinator_handle === handle) {
      this.record(run, owner, false);
      return { reclaimed: true };
    }
    await this.runUse(run);
    return { reclaimed: true };
  }

  /** Records a run this backend created (run-create receipt) or resumed. */
  async track(run: string, owner?: RunOwner): Promise<void> {
    const handle = await this.handle();
    const shown = owner ?? (await this.show(run));
    this.record(run, shown, shown.coordinator_handle !== handle);
  }
  untrack(run: string): void {
    const state = this.load();
    const runs = { ...state.runs };
    delete runs[run];
    this.checkedAt.delete(run);
    this.save({ ...state, runs });
  }

  /**
   * SPEC §15 `identity`: ensure, then retry once with the same request id
   * (the operation closes over it). `consumer_fenced` checks ownership at once.
   */
  async withIdentity<T>(
    run: string | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof PortError)) throw error;
      if (error.category === 'identity') {
        await this.ensure({ force: true });
        return operation();
      }
      if (error.category === 'hijacked' && run)
        await this.checkOwnership(run, { force: true });
      throw error;
    }
  }

  /** Identity events for T6's next batch; `identity_restored` also triggers its inbox backfill. */
  drainEvents(): RuntimeEvent[] {
    return this.events.splice(0);
  }

  health(): IdentityHealth {
    const runs = Object.values(this.load().runs);
    return {
      shim: this.live ? 'ready' : 'missing',
      ...(this.location ? { shimLocation: this.location } : {}),
      ownership: runs.some((run) => run.hijacked)
        ? 'hijacked'
        : runs.length
          ? 'owned'
          : 'none',
      warnings: this.fallback ? ['shim_folder_fallback'] : [],
    };
  }

  /** Normal shutdown. Closes the shim only with `orca.shim.closeOnExit`; runs are rebound next start. */
  async close(): Promise<void> {
    const state = this.load();
    if (!this.options.closeOnExit || !state.handle) return;
    await this.closeTerminal(state.handle);
    this.save({ ...state, handle: null, incarnationId: null });
    this.live = false;
  }

  private async ensureNow(): Promise<IdentityStatus> {
    const location = await this.resolveLocation();
    const { result } = await this.options.cli.run(
      ['terminal', 'list', '--worktree', `path:${location}`, '--limit', '500'],
      { kind: 'read', priority: 'identity' },
      TerminalListSchema,
    );
    const state = this.load();
    const stored = result.terminals.find(
      (terminal) =>
        terminal.handle === state.handle &&
        state.location === location &&
        (!state.incarnationId ||
          !terminal.incarnationId ||
          terminal.incarnationId === state.incarnationId),
    );
    const titled = result.terminals.filter(
      (terminal) =>
        terminal !== stored && terminal.title?.includes(this.marker) === true,
    );
    // A same-handle entry with a new incarnation is not the shim we bound.
    const adoptable = titled.filter(
      (terminal) => terminal.handle !== state.handle,
    );
    const shim = stored ?? newest(adoptable) ?? (await this.create(location));
    for (const duplicate of titled)
      if (duplicate.handle !== shim.handle)
        await this.closeTerminal(duplicate.handle);
    this.save({
      ...state,
      handle: shim.handle,
      incarnationId: shim.incarnationId ?? null,
      location,
      history: [
        ...state.history.filter((handle) => handle !== shim.handle),
        shim.handle,
      ].slice(-20),
    });
    this.live = true;
    this.ensuredAt = this.now();
    const rebound: string[] = [];
    for (const [run, record] of Object.entries(state.runs))
      if (
        !record.hijacked &&
        record.handle !== shim.handle &&
        state.history.includes(record.handle)
      ) {
        await this.runUse(run);
        rebound.push(run);
      }
    if (!rebound.length) return { handle: shim.handle, restored: false };
    this.events.push({
      type: 'runtime.identity_restored',
      externalKey: `orca:identity_restored:${shim.handle}`,
      occurredAt: new Date(this.now()).toISOString(),
      newShim: shim.handle,
      runs: rebound,
    });
    return { handle: shim.handle, restored: true, runs: rebound };
  }

  /** P1: the folder workspace must already be registered; never `repo add` here. */
  private async resolveLocation(): Promise<string> {
    if (this.location) return this.location;
    const main = this.options.repoMainWorktree;
    if (this.options.shimLocation === 'repo-main-worktree') {
      if (!main) throw guard('shim_location_unavailable');
      return (this.location = resolve(main));
    }
    const home = resolve(join(this.options.dataDir, 'orca-home'));
    const { result } = await this.options.cli.run(
      ['repo', 'list'],
      { kind: 'read', priority: 'identity' },
      RepoListSchema,
    );
    if (result.repos.some((repo) => resolve(repo.path) === home))
      return (this.location = home);
    if (!main) throw guard('shim_folder_workspace_unregistered');
    this.fallback = true;
    return (this.location = resolve(main));
  }

  private async create(location: string): Promise<Terminal> {
    const { result } = await this.options.cli.run(
      [
        'terminal',
        'create',
        '--worktree',
        `path:${location}`,
        '--title',
        `AI Office · 請勿關閉 ${this.marker}`,
        '--command',
        'exec cat > /dev/null',
      ],
      { kind: 'mutate', priority: 'identity' },
      TerminalCreateSchema,
    );
    return result.terminal;
  }

  private async closeTerminal(handle: string): Promise<void> {
    this.closable.add(handle);
    try {
      await this.options.cli.run(['terminal', 'close'], {
        kind: 'mutate',
        priority: 'identity',
        terminal: handle,
      });
    } catch (error) {
      // Already gone is the goal; anything else is retried on a later ensure.
      if (!(error instanceof PortError)) throw error;
    } finally {
      this.closable.delete(handle);
    }
  }

  private async runUse(run: string): Promise<void> {
    const { result } = await this.options.cli.run(
      ['orchestration', 'run-use', '--id', run],
      { kind: 'mutate', priority: 'identity', requestId: randomUUID() },
    );
    // run-use changes consumer_generation: record it now so it is not a hijack.
    const parsed = RunOwnerSchema.safeParse(result);
    this.record(
      run,
      parsed.success ? parsed.data.run : await this.show(run),
      false,
    );
  }

  private async show(run: string): Promise<RunOwner> {
    const { result } = await this.options.cli.run(
      ['orchestration', 'run-show', '--id', run, '--full'],
      { kind: 'read', priority: 'identity' },
      RunOwnerSchema,
    );
    return result.run;
  }

  private record(run: string, owner: RunOwner, hijacked: boolean): void {
    const state = this.load();
    this.save({
      ...state,
      runs: {
        ...state.runs,
        [run]: {
          handle: owner.coordinator_handle ?? '',
          generation: owner.consumer_generation,
          hijacked,
        },
      },
    });
  }

  private async handle(): Promise<string> {
    return this.load().handle ?? (await this.ensure({ force: true })).handle;
  }

  private load(): State {
    return (
      StateSchema.safeParse(this.options.state.read(STATE_KEY)).data ?? {
        v: 1,
        handle: null,
        incarnationId: null,
        location: null,
        history: [],
        runs: {},
      }
    );
  }
  private save(state: State): void {
    this.options.state.write(STATE_KEY, state);
  }
}
