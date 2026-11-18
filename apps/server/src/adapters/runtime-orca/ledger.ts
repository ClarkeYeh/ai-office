import { z } from 'zod';
import type { AdapterState } from './state.js';
import { contractMismatch, guard } from './errors.js';
import { agentRef } from './refs.js';
const EntrySchema = z.object({
  commandId: z.string().min(1),
  state: z.enum(['pending', 'started']),
  run: z.string().min(1),
  dispatch: z.string().optional(),
  agent: z.string().optional(),
  attemptId: z.string().optional(),
  keepOpen: z.boolean(),
  stoppedByBackend: z.boolean(),
});
export type LedgerEntry = z.infer<typeof EntrySchema>;
const WorkerSchema = z.object({
  dispatchId: z.string(),
  taskId: z.string(),
  runId: z.string(),
  followUpOf: z.string().nullish(),
  resource: z
    .object({
      originDispatchId: z.string().nullish(),
      retainedReason: z.string().nullish(),
    })
    .nullish(),
});
const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  runId: z.string().optional(),
});
export const LedgerWorkersSchema = z.object({ workers: z.array(WorkerSchema) });
export const LedgerTasksSchema = z.object({ tasks: z.array(TaskSchema) });
/** Cache only: lost stoppedByBackend is reconstructed by application command history. */
export class DispatchLedger {
  private entries: LedgerEntry[];
  constructor(private readonly store: AdapterState) {
    this.entries =
      z.array(EntrySchema).safeParse(store.read('orca:dispatch-ledger')).data ??
      [];
  }
  all(): LedgerEntry[] {
    return structuredClone(this.entries);
  }
  byCommand(commandId: string): LedgerEntry | undefined {
    return this.all().find((entry) => entry.commandId === commandId);
  }
  byDispatch(dispatch: string): LedgerEntry | undefined {
    return this.all().find((entry) => entry.dispatch === dispatch);
  }
  agentFor(dispatch: string) {
    const entry = this.byDispatch(dispatch);
    return entry?.state === 'started'
      ? agentRef(entry.agent ?? dispatch)
      : undefined;
  }
  isPendingTitle(title: string): boolean {
    const commandId = /^aio:([^\s]+)(?:\s|$)/.exec(title)?.[1];
    return (
      commandId !== undefined && this.byCommand(commandId)?.state === 'pending'
    );
  }
  pending(input: {
    commandId: string;
    run: string;
    keepOpen: boolean;
    attemptId?: string;
  }): void {
    const existing = this.byCommand(input.commandId);
    if (existing) {
      if (
        existing.run !== input.run ||
        existing.attemptId !== input.attemptId ||
        existing.keepOpen !== input.keepOpen
      )
        throw guard('ledger_command_mismatch');
      return;
    }
    this.commit([
      ...this.entries,
      { ...input, state: 'pending', stoppedByBackend: false },
    ]);
  }
  started(
    commandId: string,
    dispatch: string,
    followUpOf?: string,
  ): LedgerEntry {
    const entry = this.byCommand(commandId);
    if (!entry) throw guard('ledger_pending_required');
    if (entry.dispatch && entry.dispatch !== dispatch)
      throw guard('ledger_dispatch_mismatch');
    const parent = followUpOf ? this.byDispatch(followUpOf) : undefined;
    if (followUpOf && (!parent || parent.run !== entry.run))
      throw guard('ledger_followup_unknown');
    const started: LedgerEntry = {
      ...entry,
      state: 'started',
      dispatch,
      agent: parent?.agent ?? parent?.dispatch ?? dispatch,
      ...(parent?.attemptId ? { attemptId: parent.attemptId } : {}),
    };
    this.commit(
      this.entries.map((e) => (e.commandId === commandId ? started : e)),
    );
    return structuredClone(started);
  }
  stopped(dispatch: string): void {
    if (!this.byDispatch(dispatch)) throw guard('ledger_dispatch_unknown');
    this.commit(
      this.entries.map((e) =>
        e.dispatch === dispatch ? { ...e, stoppedByBackend: true } : e,
      ),
    );
  }
  /** Supply complete, paginated worker-list and task-list result arrays for one run. */
  rebuild(run: string, workerResult: unknown, taskResult: unknown): void {
    const workers = LedgerWorkersSchema.safeParse(workerResult);
    const tasks = LedgerTasksSchema.safeParse(taskResult);
    if (!workers.success || !tasks.success) throw contractMismatch();
    const next = this.all();
    const candidates = workers.data.workers
      .filter((w) => w.runId === run)
      .map((worker) => {
        const task = tasks.data.tasks.find(
          (t) => t.id === worker.taskId && (!t.runId || t.runId === run),
        );
        return {
          worker,
          commandId: task && /^aio:([^\s]+)(?:\s|$)/.exec(task.title)?.[1],
        };
      });
    // First recover every command, then resolve links (worker-list is newest first).
    for (const { worker, commandId } of candidates) {
      if (!commandId) continue;
      const previous = next.find((e) => e.commandId === commandId);
      if (previous && previous.run !== run)
        throw guard('ledger_command_mismatch');
      const recovered: LedgerEntry = {
        commandId,
        run,
        state: 'started',
        dispatch: worker.dispatchId,
        agent: previous?.agent ?? worker.dispatchId,
        keepOpen:
          previous?.keepOpen ??
          worker.resource?.retainedReason === 'user_requested',
        stoppedByBackend: previous?.stoppedByBackend ?? false,
        ...(previous?.attemptId ? { attemptId: previous.attemptId } : {}),
      };
      const index = next.findIndex((e) => e.commandId === commandId);
      if (index < 0) next.push(recovered);
      else next[index] = recovered;
    }
    for (let i = 0; i < candidates.length; i++) {
      for (const { worker } of candidates) {
        const entry = next.find(
          (e) => e.dispatch === worker.dispatchId && e.run === run,
        );
        const parentId = worker.followUpOf ?? worker.resource?.originDispatchId;
        const parent = next.find(
          (e) => e.dispatch === parentId && e.run === run,
        );
        if (entry && parent && entry !== parent) {
          entry.agent = parent.agent ?? parent.dispatch!;
          if (parent.attemptId) entry.attemptId = parent.attemptId;
        }
      }
    }
    this.commit(next);
  }
  private commit(entries: LedgerEntry[]): void {
    this.store.write('orca:dispatch-ledger', entries);
    this.entries = structuredClone(entries);
  }
}
