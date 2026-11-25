import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  CommandResultSchema,
  type CommandResult,
} from '@ai-office/contracts/events';
import type { RuntimePort, Correlation } from '../../../ports/runtime.js';
import type {
  AgentRef,
  QuestionRef,
  WorkspaceRef,
} from '../../../ports/refs.js';
import { PortError } from '../../../ports/errors.js';
import { agentRef, workspaceRef } from '../refs.js';
import { guard } from '../errors.js';
import {
  Context,
  digest,
  hasMarker,
  marker,
  object,
  parse,
  text,
  transient,
} from './context.js';
import { completeTaskList, pageWorkerList } from '../ledger.js';
import { markerToken, sameCommand } from '../marker.js';
import { Workspaces } from './workspaces.js';

const Worker = z.looseObject({
  dispatchId: text,
  taskId: text,
  runId: text,
  workerState: z.string().optional(),
  terminalState: z.string().nullish(),
  agentTerminalHandle: z.string().nullish(),
  terminal: z.string().nullish(),
  followUpOf: z.string().nullish(),
  resource: z
    .looseObject({
      originDispatchId: z.string().nullish(),
      ownerDispatchId: z.string().nullish(),
      retainedReason: z.string().nullish(),
      worktreeId: z.string().nullish(),
    })
    .nullish(),
});
const Task = z.looseObject({
  id: text,
  title: z.string(),
  runId: z.string().optional(),
});
const Run = z.looseObject({ id: text, objective: z.string() });
const Message = z.looseObject({
  id: text,
  subject: z.string().nullish(),
  body: z.string().nullish(),
  type: z.string().optional(),
  thread_id: z.string().nullish(),
});
/**
 * Agent launch flags for `worker-start`. Orca 1.4.259 rejects `--effort`
 * without `--model` (`invalid_argument`), and v0.1 templates set no per-role
 * model, so a model-less effort is dropped: the agent runs with its own
 * configured model and effort.
 */
export function workerStartLaunchArgs(
  req: Pick<
    Parameters<RuntimePort['spawnAgent']>[0],
    'agent' | 'model' | 'effort'
  >,
): { args: string[]; droppedEffort: boolean } {
  return {
    args: [
      '--agent',
      req.agent === 'claude-code' ? 'claude' : 'codex',
      ...(req.model ? ['--model', req.model] : []),
      ...(req.model && req.effort ? ['--effort', req.effort] : []),
    ],
    droppedEffort: !req.model && !!req.effort,
  };
}
const Receipt = z.looseObject({
  state: text,
  dispatchId: z.string().optional(),
  followUpOf: z.string().nullish(),
  delivery: z.string().optional(),
  mode: z.looseObject({ mode: text }).optional(),
});
export class Agents {
  private readonly activeSpawns = new Set<string>();
  private loggedDroppedEffort = false;
  constructor(
    readonly c: Context,
    readonly workspaces: Workspaces,
  ) {}
  async runs() {
    return (
      await this.c.call(
        ['orchestration', 'run-list', '--full'],
        z.looseObject({ runs: z.array(Run) }),
      )
    ).runs;
  }
  async workers(run: string) {
    return pageWorkerList((pageArgs) =>
      this.c.call(
        ['orchestration', 'worker-list', '--full', ...pageArgs],
        z.looseObject({ workers: z.array(Worker) }),
        run,
      ),
    );
  }
  async rebuild(run: string, settleCommand?: string) {
    const workers = await this.workers(run);
    const tasks = await this.c.call(
      ['orchestration', 'task-list'],
      z.looseObject({ tasks: z.array(Task) }).refine(completeTaskList),
      run,
    );
    const visibleTasks = tasks.tasks.filter((task) => {
      const id = markerToken(task.title);
      return (
        !id ||
        ![...this.activeSpawns].some((spawn) => sameCommand(spawn, id)) ||
        (settleCommand !== undefined && sameCommand(settleCommand, id))
      );
    });
    this.c.options.ledger.rebuild(run, { workers }, { tasks: visibleTasks });
    return workers;
  }
  async entry(agent: AgentRef) {
    const ledger = this.c.options.ledger;
    let entry = ledger.byDispatch(agent);
    if (!entry) {
      const shown = await this.c.call(
        ['orchestration', 'worker-show', '--dispatch', agent, '--full'],
        z.looseObject({ dispatch: z.looseObject({ runId: text }) }),
      );
      await this.rebuild(shown.dispatch.runId);
      entry = ledger.byDispatch(agent);
    }
    if (!entry) throw guard('dispatch_not_managed');
    // Resource ownership survives a restart even when worker-list is newest first.
    const root = entry.agent ?? agent;
    const rows = await this.rebuild(entry.run);
    const owned = rows.find(
      (w) =>
        ledger.agentFor(w.dispatchId) === root &&
        w.resource?.ownerDispatchId === w.dispatchId,
    );
    if (owned) return ledger.byDispatch(owned.dispatchId)!;
    // In-process follow-ups are appended in order.
    return (
      ledger
        .all()
        .filter(
          (e) => e.agent === (entry!.agent ?? agent) && e.state === 'started',
        )
        .at(-1) ?? entry
    );
  }
  async messages(run: string, dispatch?: string) {
    return (
      await this.c.call(
        ['orchestration', 'inbox', '--full'],
        z.looseObject({ messages: z.array(Message) }),
        run,
        undefined,
        dispatch ?? true,
      )
    ).messages;
  }
  /** M5 §4.2: the worktree a `new-worktree` spawn created, from adapter state. */
  spawned(commandId: string): WorkspaceRef | undefined {
    const p = z
      .object({ id: text, created: z.literal(true) })
      .safeParse(this.c.options.state.read(`orca:workspace:${commandId}`));
    return p.success ? workspaceRef(p.data.id) : undefined;
  }
  private spawnResult(commandId: string, agent: string): CommandResult {
    const workspace = this.spawned(commandId);
    return {
      kind: 'runtime.spawnAgent',
      result: workspace === undefined ? { agent } : { agent, workspace },
    };
  }
  async find(commandId: string): Promise<CommandResult | null> {
    const cached = this.c.options.state.read(`orca:result:${commandId}`);
    if (cached) return parse(CommandResultSchema, cached);
    for (const run of await this.runs()) {
      if (hasMarker(run.objective, commandId))
        return { kind: 'runtime.openSession', result: { session: run.id } };
      const workers = await this.rebuild(run.id);
      const entry = this.c.options.ledger.byCommand(commandId);
      if (entry?.dispatch && entry.state === 'started') {
        if (
          workers.find((w) => w.dispatchId === entry.dispatch)?.workerState ===
          'failed'
        )
          throw new PortError('permanent', 'failed', 'Worker start failed');
        const command = this.c.options.state.read(`orca:kind:${commandId}`);
        return command === 'runtime.send' || entry.agent !== entry.dispatch
          ? { kind: 'runtime.send', result: {} }
          : this.spawnResult(commandId, entry.agent ?? entry.dispatch);
      }
      for (const message of await this.messages(run.id)) {
        if (
          hasMarker(message.subject ?? '', commandId) ||
          hasMarker(message.body ?? '', commandId)
        )
          return message.thread_id
            ? { kind: 'runtime.answer', result: {} }
            : { kind: 'runtime.send', result: {} };
      }
      // Replies are delivered to the dispatch inbox, not back into the run inbox.
      for (const worker of workers) {
        if (!this.c.options.ledger.byDispatch(worker.dispatchId)) continue;
        const reply = (await this.messages(run.id, worker.dispatchId)).find(
          (m) =>
            m.thread_id &&
            m.type !== 'question' &&
            hasMarker(m.body ?? '', commandId),
        );
        if (reply) return { kind: 'runtime.answer', result: {} };
      }
    }
    return null;
  }
  async inspect(
    requestId: string,
    commandId: string,
  ): ReturnType<RuntimePort['inspectRequest']> {
    let r;
    try {
      r = await this.c.call(
        ['orchestration', 'request-show', '--request', requestId, '--full'],
        z.looseObject({
          state: text,
          method: z.string().optional(),
          receipt: object.nullish(),
        }),
      );
    } catch (e) {
      if (
        e instanceof PortError &&
        ['request_not_found', 'not_found'].includes(e.code)
      )
        return { status: 'absent' };
      throw e;
    }
    if (['absent', 'not_found'].includes(r.state)) return { status: 'absent' };
    if (r.state !== 'completed' || !r.receipt) return { status: 'pending' };
    const receipt = r.receipt;
    if (
      receipt.state === 'failed' &&
      ['orchestration.workerStart', 'orchestration.send'].includes(
        r.method ?? '',
      )
    )
      throw new PortError('permanent', 'failed', 'Runtime mutation failed');
    if (
      ['outcome_unknown', 'release_unknown', 'stop_unknown'].includes(
        String(receipt.state),
      )
    )
      return { status: 'pending' };
    let result: CommandResult | null = null;
    if (r.method === 'orchestration.runCreate') {
      const p = parse(z.looseObject({ run: Run }), receipt);
      result = { kind: 'runtime.openSession', result: { session: p.run.id } };
    } else if (r.method === 'orchestration.workerStart') {
      const p = parse(Receipt, receipt);
      if (
        p.dispatchId &&
        ['ready', 'started', 'starting', 'input_accepted'].includes(p.state)
      )
        result = {
          kind: 'runtime.spawnAgent',
          result: { agent: p.dispatchId },
        };
    } else if (r.method === 'orchestration.send')
      result = { kind: 'runtime.send', result: {} };
    else if (r.method === 'orchestration.reply')
      result = { kind: 'runtime.answer', result: {} };
    else if (r.method === 'orchestration.workerStop')
      result = { kind: 'runtime.stop', result: {} };
    else if (r.method === 'orchestration.workerRelease')
      result = { kind: 'runtime.release', result: {} };
    if (!result) result = await this.find(commandId);
    return result ? { status: 'completed', result } : { status: 'pending' };
  }
  async spawn(req: Parameters<RuntimePort['spawnAgent']>[0]) {
    const id = req.correlation.commandId,
      { ledger, state } = this.c.options;
    this.c.check(id, req);
    state.write(`orca:kind:${id}`, 'runtime.spawnAgent');
    if (state.read(`orca:failed:${id}`)) {
      await this.cleanupFailed(req.session, id);
      throw new PortError('permanent', 'failed', 'Worker start failed');
    }
    const prior = ledger.byCommand(id);
    if (
      prior?.state === 'started' &&
      prior.dispatch &&
      state.read(`orca:result:${id}`)
    )
      return agentRef(prior.agent ?? prior.dispatch);
    if (prior) {
      const recovery = await this.recover(req.session, id);
      if (recovery) return recovery;
      // A pending ledger can mean the process died just before or after worker-start.
      // Only the same retry request is allowed to cross the CLI boundary again.
    }
    const repo = this.c.sessions()[req.session];
    let workspace =
      req.workspace.kind === 'existing-worktree'
        ? await this.workspaces.show(req.workspace.workspace)
        : null;
    let owns = false;
    if (req.workspace.kind === 'new-worktree') {
      if (!repo) throw guard('session_repo_unknown');
      const p = await this.workspaces.prepare({
        session: req.session,
        repo,
        ...req.workspace,
        // Legacy WorkspaceReq names a branch, while prepareWorkspace requires an explicit fetched base.
        ...(!/^[a-f0-9]{40}$/.test(req.workspace.baseBranch)
          ? {
              baseBranch: `origin/${req.workspace.baseBranch.replace(/^origin\//, '')}`,
              fetchBranch: req.workspace.baseBranch.replace(/^origin\//, ''),
            }
          : {}),
        correlation: { ...req.correlation, commandId: `${id}/workspace` },
      });
      workspace = await this.workspaces.show(p.workspace);
      owns = true;
    }
    if (!workspace) throw guard('workspace_missing');
    owns = owns || (await this.workspaces.preparedHere(workspace.id));
    if (!isAbsolute(this.c.options.dataDir))
      throw guard('data_dir_must_be_absolute');
    const dir = join(this.c.options.dataDir, 'orca-specs');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const spec = join(dir, `${digest(id)}.txt`);
    try {
      await writeFile(spec, req.prompt, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if ((await readFile(spec, 'utf8')) !== req.prompt)
        throw new PortError(
          'bug',
          'spec_mismatch',
          'Launch specification changed',
        );
    }
    // M5 §4.2: `created` marks the worktree this spawn made (new-worktree).
    state.write(`orca:workspace:${id}`, {
      id: workspace.id,
      owns,
      ...(req.workspace.kind === 'new-worktree' ? { created: true } : {}),
    });
    ledger.pending({
      commandId: id,
      run: req.session,
      keepOpen: req.keepOpen,
      ...(req.correlation.attemptId
        ? { attemptId: req.correlation.attemptId }
        : {}),
    });
    const launch = workerStartLaunchArgs(req);
    if (launch.droppedEffort && !this.loggedDroppedEffort) {
      this.loggedDroppedEffort = true;
      this.c.options.logger.info(
        { effort: req.effort },
        'effort ignored without a model; agents use their own configured effort',
      );
    }
    this.activeSpawns.add(id);
    try {
      const r = await this.c.call(
        [
          'orchestration',
          'worker-start',
          ...launch.args,
          '--worktree',
          `path:${workspace.path}`,
          '--task-title',
          `${marker(id)} ${req.title}`,
          '--spec-file',
          spec,
          ...(req.keepOpen ? ['--keep-open'] : []),
        ],
        Receipt,
        req.session,
        id,
      );
      if (r.state === 'failed')
        throw new PortError('permanent', 'failed', 'Worker start failed');
      if (r.state === 'outcome_unknown') throw transient('outcome_unknown');
      if (!r.dispatchId) throw transient('outcome_unknown');
      if (r.mode && r.mode.mode !== 'terminal')
        state.write('orca:chat-worker-degraded', true);
      ledger.started(id, r.dispatchId);
      this.c.save(id, this.spawnResult(id, r.dispatchId));
      return agentRef(r.dispatchId);
    } catch (e) {
      if (!(e instanceof PortError)) throw e;
      if (e.code === 'failed') {
        state.write(`orca:failed:${id}`, true);
        await this.cleanupFailed(req.session, id);
        throw e;
      }
      if (e.code === 'outcome_unknown' || e.category === 'transient') {
        const recovered = await this.recover(req.session, id);
        if (recovered) return recovered;
        throw transient('outcome_unknown');
      }
      throw e;
    } finally {
      this.activeSpawns.delete(id);
    }
  }
  async cleanupFailed(run: string, id: string) {
    // CLI drops failed receipt details: rebuild from the exact aio command marker.
    await this.rebuild(run, id);
    const entry = this.c.options.ledger.byCommand(id);
    if (entry?.dispatch)
      await this.releaseDispatch(entry.dispatch, run, `${id}/failed-release`);
    else throw transient('failed_start_cleanup_pending');
  }
  async recover(run: string, id: string): Promise<AgentRef | null> {
    let r: Awaited<ReturnType<RuntimePort['inspectRequest']>>;
    try {
      r = await this.inspect(this.c.options.ids.orcaRequestId(id), id);
    } catch (error) {
      if (error instanceof PortError && error.code === 'failed') {
        this.c.options.state.write(`orca:failed:${id}`, true);
        await this.cleanupFailed(run, id);
      }
      throw error;
    }
    if (r.status === 'completed' && r.result.kind === 'runtime.spawnAgent') {
      this.c.options.ledger.started(id, r.result.result.agent);
      this.c.save(id, r.result);
      return agentRef(r.result.result.agent);
    }
    const workers = await this.rebuild(run, id);
    const e = this.c.options.ledger.byCommand(id);
    if (
      e?.dispatch &&
      workers.find((w) => w.dispatchId === e.dispatch)?.workerState === 'failed'
    ) {
      this.c.options.state.write(`orca:failed:${id}`, true);
      await this.releaseDispatch(e.dispatch, run, `${id}/failed-release`);
      throw new PortError('permanent', 'failed', 'Worker start failed');
    }
    if (e?.state === 'started' && e.dispatch) {
      const agent = agentRef(e.agent ?? e.dispatch);
      this.c.save(id, this.spawnResult(id, agent));
      return agent;
    }
    if (r.status === 'pending') throw transient('outcome_unknown');
    return null;
  }
  async send(agent: AgentRef, msg: Parameters<RuntimePort['send']>[1]) {
    const id = msg.correlation.commandId;
    this.c.check(id, { agent, msg });
    if (this.c.options.state.read(`orca:result:${id}`)) return;
    const remembered = this.c.options.state.read(`orca:send-target:${id}`);
    const entry = remembered
      ? parse(
          z.object({
            run: text,
            dispatch: text,
            keepOpen: z.boolean(),
            attemptId: z.string().optional(),
          }),
          remembered,
        )
      : await this.entry(agent);
    this.c.options.state.write(`orca:send-target:${id}`, entry);
    const ledger = this.c.options.ledger;
    // Only a worker without keep-open can be released under us; a kept-open
    // one needs no worker-list per send (FX-STATUS-CADENCE).
    if (!entry.keepOpen) {
      const rows = await this.workers(entry.run);
      const row = rows.find((w) => w.dispatchId === entry.dispatch);
      if (row?.terminalState === 'released') throw guard('dispatch_released');
    }
    this.c.options.state.write(`orca:kind:${id}`, 'runtime.send');
    ledger.pending({
      commandId: id,
      run: entry.run,
      keepOpen: entry.keepOpen,
      ...(entry.attemptId ? { attemptId: entry.attemptId } : {}),
    });
    const r = await this.c.call(
      [
        'orchestration',
        'send',
        '--to',
        `dispatch:${entry.dispatch}`,
        '--subject',
        `${marker(id)} ${msg.subject}`,
        '--body',
        msg.body,
      ],
      object,
      entry.run,
      id,
    );
    if (r.delivery === 'follow_up') {
      const follow = parse(
        z.looseObject({ dispatchId: text, followUpOf: text }),
        r,
      );
      if (follow.followUpOf !== entry.dispatch)
        throw guard('followup_parent_mismatch');
      ledger.started(id, follow.dispatchId, follow.followUpOf);
      const root = ledger.byDispatch(ledger.agentFor(follow.dispatchId)!);
      if (root)
        this.c.options.state.write(`orca:released:${root.commandId}`, false);
    } else ledger.discard(id);
    this.c.save(id, { kind: 'runtime.send', result: {} });
  }
  async answer(question: QuestionRef, body: string, correlation: Correlation) {
    this.c.check(correlation.commandId, { question, body, correlation });
    for (const run of await this.runs()) {
      if (
        !this.c.sessions()[run.id] &&
        !this.c.options.ledger.all().some((e) => e.run === run.id)
      )
        continue;
      if (!(await this.messages(run.id)).some((m) => m.id === question))
        continue;
      await this.c.call(
        [
          'orchestration',
          'reply',
          '--id',
          question,
          '--body',
          `${marker(correlation.commandId)}\n${body}`,
        ],
        object,
        run.id,
        correlation.commandId,
      );
      this.c.save(correlation.commandId, {
        kind: 'runtime.answer',
        result: {},
      });
      return;
    }
    throw guard('question_not_found');
  }
  async stop(agent: AgentRef) {
    const e = await this.entry(agent);
    try {
      const r = await this.c.call(
        ['orchestration', 'worker-stop', '--dispatch', e.dispatch!],
        object,
        e.run,
        `stop:${e.dispatch}`,
      );
      if (r.state === 'stop_unknown') throw transient('stop_unknown');
    } catch (error) {
      if (!(error instanceof PortError) || error.code !== 'stop_unknown')
        throw error;
      const r = await this.c.call(
        ['orchestration', 'worker-show', '--dispatch', e.dispatch!, '--full'],
        z.looseObject({ worker: z.looseObject({ state: text }) }),
      );
      if (
        !['stopped', 'succeeded', 'failed', 'released'].includes(r.worker.state)
      )
        throw transient('stop_unknown');
    }
    this.c.options.ledger.stopped(e.dispatch!);
  }
  async releaseDispatch(dispatch: string, run: string, id: string) {
    // M2-T17 D8: a release that reaches Orca before a concurrent stop has
    // settled is refused `dispatch_inactive`. A settled dispatch with no live
    // terminal counts as released; otherwise retry (transient) once the stop
    // settles, under a fresh request id so the refusal is not replayed.
    const retries = `orca:release-retry:${dispatch}`;
    const tries = z
      .number()
      .int()
      .catch(0)
      .parse(this.c.options.state.read(retries));
    try {
      await this.c.call(
        ['orchestration', 'worker-release', '--dispatch', dispatch],
        object,
        run,
        tries ? `${id}#${tries}` : id,
      );
    } catch (e) {
      if (!(e instanceof PortError)) throw e;
      if (e.code === 'dispatch_inactive') {
        if (!(await this.settledWithoutTerminal(run, dispatch))) {
          this.c.options.state.write(retries, tries + 1);
          throw transient('release_pending_stop');
        }
      } else if (e.code !== 'already_released') throw e;
    }
    const entry = this.c.options.ledger.byDispatch(dispatch);
    const root =
      entry && this.c.options.ledger.byDispatch(entry.agent ?? dispatch);
    if (root)
      this.c.options.state.write(`orca:released:${root.commandId}`, true);
  }
  /** Stopped/finished, and its terminal is released or no longer its own. */
  private async settledWithoutTerminal(run: string, dispatch: string) {
    const row = (await this.workers(run)).find(
      (w) => w.dispatchId === dispatch,
    );
    return (
      row !== undefined &&
      ['stopped', 'succeeded', 'failed', 'cancelled'].includes(
        row.workerState ?? '',
      ) &&
      (row.terminalState == null || row.terminalState === 'released')
    );
  }
  async release(agent: AgentRef, opts: { removeWorkspace: boolean }) {
    const e = await this.entry(agent);
    await this.releaseDispatch(e.dispatch!, e.run, `release:${e.dispatch}`);
    if (opts.removeWorkspace) {
      const original = this.c.options.ledger.byDispatch(e.agent ?? agent);
      const owned =
        original &&
        this.c.options.state.read(`orca:workspace:${original.commandId}`);
      const p = z.object({ id: text, owns: z.boolean() }).safeParse(owned);
      if (
        !p.success ||
        !p.data.owns ||
        !(await this.workspaces.preparedHere(p.data.id))
      )
        return;
      const rows = await this.rebuild(e.run);
      for (const other of this.c.options.ledger.all()) {
        if (
          (other.agent ?? other.dispatch) === (e.agent ?? agent) &&
          other.state === 'started'
        )
          continue;
        const root = other.agent
          ? (this.c.options.ledger.byDispatch(other.agent) ?? other)
          : other;
        const metadata = z
          .object({ id: text })
          .safeParse(
            this.c.options.state.read(`orca:workspace:${root.commandId}`),
          );
        const row = rows.find((w) => w.dispatchId === other.dispatch);
        if (
          metadata.data?.id !== p.data.id &&
          row?.resource?.worktreeId !== p.data.id
        )
          continue;
        if (
          this.c.options.state.read(`orca:released:${root.commandId}`) ===
            true ||
          row?.terminalState === 'released'
        )
          continue;
        throw guard('workspace_in_use');
      }
      await this.workspaces.dispose(
        p.data.id as Parameters<RuntimePort['disposeWorkspace']>[0],
      );
    }
  }
  async resolve(identity: Parameters<RuntimePort['resolveCaller']>[0]) {
    for (const run of await this.runs()) {
      const workers = await this.rebuild(run.id);
      for (const w of workers) {
        if ((w.terminal ?? w.agentTerminalHandle) !== identity.terminalHandle)
          continue;
        if (identity.paneKey) {
          const detail = await this.c.call(
            [
              'orchestration',
              'worker-show',
              '--dispatch',
              w.dispatchId,
              '--full',
            ],
            z.looseObject({
              dispatch: z.looseObject({
                assigneePaneKey: z.string().nullish(),
              }),
            }),
          );
          if (detail.dispatch.assigneePaneKey !== identity.paneKey) continue;
        }
        return this.c.options.ledger.agentFor(w.dispatchId) ?? null;
      }
    }
    return null;
  }
}
