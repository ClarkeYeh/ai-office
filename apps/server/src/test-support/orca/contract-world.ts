/** Synthetic Orca wire model, NOT a live recording. See contract/synthetic/README.md. */
import { FakeClock } from '../services.js';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { ReplayExec, Normalizer, type Recording } from './recording.js';
import type {
  Exec,
  ExecRequest,
} from '../../adapters/runtime-orca/cli/types.js';

export const RUN = 'run_contract';
export const SHA = 'a'.repeat(40);
export const REPO = {
  orcaRepoId: 'repo_contract',
  localPath: '/synthetic/repo',
};
const flag = (a: readonly string[], k: string) => a[a.indexOf(k) + 1]!;
type Workspace = {
  id: string;
  path: string;
  branch: string;
  head: string;
  repoId: string;
  comment: string;
  displayName: string;
};
type Worker = {
  dispatchId: string;
  taskId: string;
  title: string;
  keepOpen: boolean;
  workerState: string;
  terminalState: string;
  activity: string;
  origin: string;
  doneAt?: number;
  wait?: unknown;
};
export class ContractWorld implements Exec {
  readonly clock = new FakeClock('2026-11-18T06:00:00Z');
  get now() {
    return this.clock.now().getTime();
  }
  set now(value: number) {
    this.clock.advance(value - this.now);
  }
  longPoll = false;
  private poll: { at: number; resolve: () => void } | undefined;
  elapsed = 0;
  owner = 'term_shim';
  shim = 'term_shim';
  generation = 1;
  identityLost = false;
  suffix = false;
  hold = false;
  lost = false;
  checkTimeout = false;
  hidden = false;
  private releaseSpawn: (() => void) | undefined;
  private startedSpawn?: () => void;
  spawnEntered = Promise.resolve();
  readonly calls: { at: number; argv: readonly string[] }[] = [];
  readonly workers: Worker[] = [];
  readonly workspaces: Workspace[] = [
    {
      id: 'wt_existing',
      path: '/synthetic/existing',
      branch: 'refs/heads/ai-office/existing',
      head: SHA,
      repoId: REPO.orcaRepoId,
      comment: `aio:existing base:${SHA}`,
      displayName: 'existing',
    },
  ];
  readonly branches = new Map<string, string>();
  readonly mail: {
    id: string;
    type: string;
    sequence: number;
    created_at: string;
    payload: string;
    body: string;
    read: boolean;
  }[] = [];
  private templates = new Map<string, Recording>();
  private seq = 0;
  private normalizer = new Normalizer();
  readonly recordings: Recording[] = [];
  readonly segments: Record<string, Recording[]> = { default: [] };
  private segment = 'default';
  private segmentId = 0;
  private tapes: Map<string, ReplayExec> | undefined;
  private lane(argv: readonly string[]) {
    return argv[1] === 'orchestration' &&
      ['worker-read', 'worker-show'].includes(argv[2] ?? '')
      ? `${argv[2]}:${flag(argv, '--dispatch')}`
      : 'main';
  }
  loadTape(segments: Record<string, Recording[]>) {
    // The observer concurrently probes/reads workers. Ordering is strict within
    // each worker command lane; unrelated workers need not win the fs race in
    // the same order on every CI host. Mutations and mailbox calls stay ordered.
    const lanes = new Set([
      'main',
      ...Object.values(segments)
        .flat()
        .map((r) => this.lane(r.argv)),
    ]);
    this.tapes = new Map(
      [...lanes].map((lane) => [
        lane,
        new ReplayExec(
          Object.fromEntries(
            Object.entries(segments).map(([name, rows]) => [
              name,
              rows.filter((r) => this.lane(r.argv) === lane),
            ]),
          ),
        ),
      ]),
    );
  }
  switchSegment(action: string) {
    this.segment = `${++this.segmentId}:${action}`;
    this.segments[this.segment] = [];
    for (const tape of this.tapes?.values() ?? []) tape.stimulus(this.segment);
  }
  assertConsumed() {
    for (const tape of this.tapes?.values() ?? []) tape.assertConsumed();
  }
  static async create() {
    const world = new ContractWorld();
    const root = new URL(
      '../../../../../fixtures/orca/1.4.259/',
      import.meta.url,
    );
    for (const [key, file] of Object.entries({
      start: 'worker-start.codex.keep-open.ok.json',
      send: 'send.follow-up.codex.ok.json',
      check: 'check.wait.worker-done.ok.json',
      inbox: 'inbox.run.full.ok.json',
      list: 'worker-list.follow-up-retained.ok.json',
      workspace: 'worktree-create.base-sha.ok.json',
      stop: 'worker-stop.already-settled.ok.json',
      release: 'worker-release.ok.json',
    }))
      world.templates.set(
        key,
        JSON.parse(await readFile(new URL(file, root), 'utf8')) as Recording,
      );
    return world;
  }
  armSpawn() {
    this.hold = true;
    this.spawnEntered = new Promise<void>((resolve) => {
      this.startedSpawn = resolve;
    });
  }
  advance(ms: number) {
    this.now += ms;
    this.elapsed += ms;
    if (this.poll && this.now - this.poll.at >= 30000) {
      this.poll.resolve();
      this.poll = undefined;
    }
    this.releaseSpawn?.();
    this.releaseSpawn = undefined;
    for (const w of this.workers)
      if (
        !w.keepOpen &&
        w.doneAt !== undefined &&
        this.elapsed - w.doneAt >= 120_000
      )
        w.terminalState = 'released';
  }
  post(dispatch: string, type: string) {
    const w = this.workers.find((w) => w.dispatchId === dispatch)!;
    this.mail.push({
      id: `msg_${++this.seq}`,
      type,
      sequence: this.seq,
      created_at: new Date(this.now).toISOString(),
      payload: JSON.stringify({
        dispatchId: dispatch,
        taskId: w.taskId,
        ...(type === 'worker_done' ? { outcome: 'succeeded' } : {}),
      }),
      body: '[synthetic message]',
      read: false,
    });
    if (type === 'worker_done') {
      w.doneAt = this.elapsed;
      w.workerState = 'succeeded';
      w.activity = 'idle';
    }
  }
  private rows() {
    return this.workers
      .filter(
        (w) => !this.hidden || w.dispatchId !== this.workers.at(-1)?.dispatchId,
      )
      .map((w) => ({
        dispatchId: w.dispatchId,
        taskId: w.taskId,
        runId: RUN,
        workerState: w.workerState,
        terminalState: w.terminalState,
        terminal: `term_${w.origin}`,
        resource: {
          ownerDispatchId: this.workers
            .filter((x) => x.origin === w.origin)
            .at(-1)!.dispatchId,
          originDispatchId: w.origin,
          retainedReason: 'user_requested',
        },
        projection: {
          parent: null,
          provider: { id: 'codex' },
          stage: { worker: w.workerState, activity: w.activity },
          liveness: {
            verdict: w.terminalState === 'released' ? 'exited' : 'live',
          },
          evidence: { lastObservedAt: Math.floor(this.now / 15_000) },
        },
      }));
  }
  async run(request: ExecRequest) {
    this.calls.push({
      at: this.now,
      argv: [basename(request.bin), ...request.args],
    });
    const a = request.args.map((arg) =>
      arg.replace(/aio-shim:[a-f0-9]{12}/g, 'aio-shim:000000000000'),
    );
    request = { ...request, args: a };
    let result: unknown = {};
    let error: string | undefined;
    let text: string | undefined;
    let exitCode = 0;
    let template: string | undefined;
    let parked = false;
    const key = a.slice(0, 2).join(' ');
    if (basename(request.bin) === 'git') {
      const [verb, arg] = a.slice(2);
      if (verb === 'fetch' || verb === 'merge-base') text = '';
      else if (verb === 'rev-parse') {
        const ref = a.at(-1)!;
        if (a.includes('--quiet')) {
          text = this.branches.get(ref.replace('refs/heads/', '')) ?? '';
          exitCode = text ? 0 : 1;
        } else text = /^[ab]{40}$/.test(ref) ? ref : SHA;
      } else if (verb === 'worktree')
        text = this.workspaces
          .map(
            (w) => `worktree ${w.path}\0HEAD ${w.head}\0branch ${w.branch}\0\0`,
          )
          .join('');
      else if (verb === 'status') text = '';
      else if (verb === 'branch') {
        if (arg === '-D') this.branches.delete(a[4]!);
        else this.branches.set(a[4]!, a[5]!);
        text = '';
      } else if (verb === 'checkout') {
        const w = this.workspaces.find((w) => w.path === a[1])!;
        w.branch = `refs/heads/${a[4]}`;
        text = '';
      } else throw new Error(`Unexpected synthetic git command: ${verb}`);
    } else
      switch (key) {
        case 'terminal list':
          result = {
            terminals: this.identityLost ? [] : [{ handle: this.shim }],
          };
          break;
        case 'terminal create':
          this.identityLost = false;
          this.shim = 'term_restored';
          result = { terminal: { handle: this.shim } };
          break;
        case 'orchestration run-show':
          result = {
            run: {
              id: RUN,
              coordinator_handle: this.owner,
              consumer_generation: this.generation,
            },
          };
          break;
        case 'orchestration run-use':
          this.owner = this.shim;
          result = {
            run: {
              id: RUN,
              coordinator_handle: this.owner,
              consumer_generation: ++this.generation,
            },
          };
          break;
        case 'orchestration run-list':
          result = { runs: [{ id: RUN, objective: 'aio:open' }] };
          break;
        case 'worktree list':
          result = { worktrees: this.workspaces };
          break;
        case 'worktree show': {
          const w = this.workspaces.find(
            (w) => `id:${w.id}` === flag(a, '--worktree'),
          );
          if (!w) error = 'worktree_not_found';
          else result = { worktree: w };
          break;
        }
        case 'worktree create': {
          const branch = flag(a, '--branch') + (this.suffix ? '-2' : '');
          this.suffix = false;
          const w = {
            id: `wt_${++this.seq}`,
            path: `/fixture/w${this.seq}`,
            branch: `refs/heads/${branch}`,
            head: flag(a, '--base-branch'),
            repoId: REPO.orcaRepoId,
            comment: flag(a, '--comment'),
            displayName: flag(a, '--name'),
          };
          this.workspaces.push(w);
          this.branches.set(branch, w.head);
          result = { worktree: w };
          template = 'workspace';
          break;
        }
        case 'worktree rm': {
          const i = this.workspaces.findIndex(
            (w) => `id:${w.id}` === flag(a, '--worktree'),
          );
          if (i >= 0) this.workspaces.splice(i, 1);
          break;
        }
        case 'orchestration worker-start': {
          const id = `ctx_${++this.seq}`;
          this.workers.push({
            dispatchId: id,
            taskId: `task_${this.seq}`,
            title: flag(a, '--task-title'),
            keepOpen: a.includes('--keep-open'),
            workerState: 'ready',
            terminalState: 'retained',
            activity: 'working',
            origin: id,
          });
          result = { state: 'ready', dispatchId: id };
          template = 'start';
          exitCode = 1;
          if (this.lost) {
            this.lost = false;
            this.hidden = true;
            error = 'ECONNRESET';
          }
          if (this.hold) {
            this.hold = false;
            parked = true;
          }
          break;
        }
        case 'orchestration worker-list':
          result = { workers: this.rows() };
          template = 'list';
          break;
        case 'orchestration task-list': {
          // Real 1.4.259 shapes (fixtures task-list*.json, M2-T17 D3): only the
          // concise view has `title`; `--full` rows use task_title / run_id.
          const tasks = this.workers.filter(
            (w) => !this.hidden || w !== this.workers.at(-1),
          );
          result = {
            runId: RUN,
            tasks: a.includes('--full')
              ? tasks.map((w) => ({
                  id: w.taskId,
                  run_id: RUN,
                  task_title: w.title,
                  display_name: w.title,
                  status: 'dispatched',
                }))
              : tasks.map((w) => ({
                  id: w.taskId,
                  status: 'dispatched',
                  title: w.title,
                })),
          };
          this.hidden = false;
          break;
        }
        case 'orchestration worker-show': {
          const w = this.workers.find(
            (w) => w.dispatchId === flag(a, '--dispatch'),
          );
          result = {
            dispatch: { runId: RUN, assigneePaneKey: 'pane_contract' },
            worker: { state: w?.workerState },
            observation: { agentWait: w?.wait ?? null },
          };
          break;
        }
        case 'orchestration worker-read':
          result = {
            source: 'transcript',
            cursor: '0',
            contentComplete: true,
          };
          break;
        case 'orchestration request-show':
          result = { state: 'absent' };
          break;
        case 'orchestration check': {
          const messages = this.mail
            .filter((m) => !m.read)
            .map((m) => ({
              id: m.id,
              type: m.type,
              created_at: m.created_at,
              payload: m.payload,
              body: m.body,
            }));
          for (const m of this.mail) m.read = true;
          result = { messages, timedOut: !messages.length };
          if (this.checkTimeout) {
            this.checkTimeout = false;
            error = 'ETIMEDOUT';
          }
          template = 'check';
          break;
        }
        case 'orchestration inbox':
          result = {
            messages:
              flag(a, '--terminal') === `run:${RUN}`
                ? [...this.mail].reverse()
                : [],
          };
          template = 'inbox';
          break;
        case 'orchestration send': {
          const previous = this.workers.find(
            (w) => `dispatch:${w.dispatchId}` === flag(a, '--to'),
          )!;
          const id = `ctx_${++this.seq}`;
          this.workers.push({
            ...previous,
            dispatchId: id,
            taskId: `task_${this.seq}`,
            title: flag(a, '--subject'),
            activity: 'working',
            workerState: 'ready',
          });
          result = {
            delivery: 'follow_up',
            dispatchId: id,
            followUpOf: previous.dispatchId,
          };
          template = 'send';
          break;
        }
        case 'orchestration reply':
          result = {};
          break;
        case 'orchestration worker-stop':
          this.workers.find(
            (w) => w.dispatchId === flag(a, '--dispatch'),
          )!.workerState = 'stopped';
          template = 'stop';
          break;
        case 'orchestration worker-release':
          this.workers.find(
            (w) => w.dispatchId === flag(a, '--dispatch'),
          )!.terminalState = 'released';
          template = 'release';
          break;
        default:
          throw new Error(`Unexpected synthetic Orca command: ${key}`);
      }
    // Each deterministic wire segment goes through T8's real ReplayExec, including
    // sanitised-body rehydration. No subprocess implementation is imported here.
    const source = template ? this.templates.get(template) : undefined;
    const recording: Recording = {
      orcaVersion: '1.4.259',
      recordedAt: '2026-11-18T00:00:00Z',
      argv: this.normalizer.argv([basename(request.bin), ...a]),
      exitCode: error ? 1 : exitCode,
      response: text ?? {
        ...((source?.response as object) ?? {}),
        ok: !error,
        ...(error ? { error: { code: error } } : { result }),
      },
      ...(text !== undefined ? { responseEncoding: 'text' as const } : {}),
      stderrLines: [],
    };
    this.recordings.push(
      structuredClone(this.normalizer.value(recording) as Recording),
    );
    this.segments[this.segment]!.push(this.recordings.at(-1)!);
    const lane = this.lane([basename(request.bin), ...a]);
    if (this.tapes && !this.tapes.has(lane))
      throw new Error('Unrecorded replay worker lane');
    const replay =
      this.tapes?.get(lane) ?? new ReplayExec({ default: [recording] });
    const output = await replay.run(request);
    if (!this.tapes) replay.assertConsumed();
    if (key === 'orchestration check' && this.longPoll)
      await new Promise<void>((resolve) => {
        this.poll = { at: this.now, resolve };
        request.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
    if (parked) {
      const pending = new Promise<void>((resolve) => {
        this.releaseSpawn = resolve;
      });
      this.startedSpawn?.();
      await pending;
    }
    return output;
  }
}
