import type { z } from 'zod';
import { PortError } from '../../../ports/errors.js';
import type {
  AgentRef,
  QuestionRef,
  RuntimeCursor,
  SessionRef,
} from '../../../ports/refs.js';
import type { RuntimeEvent } from '../../../ports/runtime-events.js';
import type { Logger } from '../../../ports/services.js';
import type { OrcaCli, RunOptions } from '../cli/types.js';
import type { CoordinatorIdentity } from '../coordinator-identity/index.js';
import { guard } from '../errors.js';
import { markerToken } from '../marker.js';
import {
  type DispatchLedger,
  workerListCursor,
  workerPageArgs,
} from '../ledger.js';
import { decodeCursor, encodeCursor, questionRef } from '../refs.js';
import {
  CursorPayloadSchema,
  type CursorPayload,
  type HeldItem,
  heldKey,
  initialPayload,
  nextCheckId,
} from './cursor.js';
import {
  activitySignature,
  type AgentState,
  currentDispatch,
  dispatchOf,
  isoOf,
  lastText,
  messageEvent,
  payloadOf,
  rawBlocks,
  stageKey,
  workerState,
} from './mapping.js';
import { detectRateLimit } from './rate-limit.js';
import {
  type CheckResult,
  CheckResultSchema,
  InboxResultSchema,
  issueSummary,
  type MailMessage,
  RequestShowSchema,
  TaskListSchema,
  type Worker,
  WorkerListSchema,
  WorkerReadSchema,
  WorkerShowSchema,
} from './schemas.js';

export interface OrcaObserverOptions {
  cli: OrcaCli;
  identity: Pick<CoordinatorIdentity, 'ensure' | 'checkOwnership'> & {
    drainEvents(): RuntimeEvent[];
  };
  ledger: DispatchLedger;
  logger?: Logger;
  now?: () => number;
  /** Bounded wait for an in-flight check per observe (SPEC §6.4: ≤ 250 ms). */
  observeWaitMs?: number;
  checkTimeoutMs?: number;
  /** True near the CLI budget: worker-list 4 s, worker-read 10 s per worker. */
  pressured?: () => boolean;
  /** Application command history, when composed; otherwise the rebuilt ledger decides. */
  ownsCommand?: (commandId: string) => boolean;
  /** `lastActivity` stall before a rate-limit `worker-show` probe. */
  stallMs?: number;
  wait?: (ms: number) => Promise<void>;
}
type Outcome =
  { ok: true; result: CheckResult } | { ok: false; error: unknown };
interface Inflight {
  requestId: string;
  promise: Promise<Outcome>;
  settled?: Outcome;
  controller: AbortController;
}
interface SessionState {
  started: boolean;
  backfill: boolean;
  /** Identity changed: receipts are per caller, so the next check takes a new id. */
  rotate: boolean;
  known: Set<string>;
  pendingSince: Map<string, number>;
  inflight?: Inflight | undefined;
  memo: { cursor: string; result: ObserveResult }[];
  listedAt: number;
  answersAt: number;
  answered: Set<string>;
  readAt: Map<string, number>;
  readSig: Map<string, string>;
  progressAt: Map<string, number>;
  probedAt: Map<string, number>;
  probeTime: Map<string, number>;
  stage: Map<string, string>;
  agentWait: Map<string, boolean>;
  limited: Set<string>;
  txIds: Map<string, Set<string>>;
  tasks: Map<string, string>;
  identity: RuntimeEvent[];
  active: boolean;
}
type ObserveResult = { events: RuntimeEvent[]; cursor: RuntimeCursor };
type Resolution =
  | { kind: 'agent'; agent: AgentRef }
  | { kind: 'held'; commandId: string }
  | { kind: 'unmanaged'; title?: string | undefined };
interface Batch {
  run: string;
  p: CursorPayload;
  st: SessionState;
  events: RuntimeEvent[];
  messages: Set<string>;
  commit: (() => void)[];
  rollback: (() => void)[];
  tasksFetched: boolean;
  rebuilt: boolean;
  mismatched: Set<string>;
  /** Terminal handle per dispatch from this batch's worker-list (D10). */
  terminals: Map<string, string | null | undefined>;
}
const MAX_INBOX = 2000;
const READ_CONCURRENCY = 4;

/**
 * SPEC §6.4 / §11.5 observation: at-least-once retrieval with idempotent landing.
 * Every message is one event keyed `orca:msg:<messageId>`; the inbox backfills
 * by `sequence` at startup, after `identity_restored` and after a check receipt
 * reads `absent`, so exactly-once never depends on receipts.
 */
/**
 * A message in a question's thread is an answer when it is our own reply
 * (`aio:<tag>` first line, `runtime.answer`) or comes from anyone but the
 * run handle. Orca 1.4.272 posts its own "decide it yourself" notice into the
 * thread from `run:<id>` as soon as a worker asks while the coordinator has no
 * running agent (always true for the shim); that notice is not an answer, so
 * the question keeps the agent in `waiting_input` (M5-T11b).
 */
export function isAnswer(
  message: {
    from_handle?: string | null | undefined;
    body?: string | null | undefined;
  },
  run: string,
): boolean {
  if (markerToken(message.body ?? '') !== undefined) return true;
  return message.from_handle !== `run:${run}`;
}

export class OrcaObserver {
  private readonly sessions = new Map<string, SessionState>();
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private escalations = 0;
  constructor(private readonly options: OrcaObserverOptions) {
    this.now = options.now ?? Date.now;
    this.wait =
      options.wait ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()));
  }

  async observe(
    session: SessionRef,
    cursor: RuntimeCursor | null,
  ): Promise<ObserveResult> {
    const st = this.state(session);
    const key = cursor ?? '';
    const memo = st.memo.find((m) => m.cursor === key);
    if (memo) return memo.result;
    const p = cursor
      ? decodeCursor(cursor, CursorPayloadSchema)
      : initialPayload(session);
    if (p.run !== session) throw guard('cursor_session_mismatch');
    if (!st.started) st.backfill = true;
    const batch: Batch = {
      run: session,
      p,
      st,
      events: [],
      messages: new Set(),
      commit: [() => void (st.started = true)],
      rollback: [],
      tasksFetched: false,
      rebuilt: false,
      terminals: new Map(),
      mismatched: new Set(),
    };
    try {
      const owned = await this.identityStep(batch);
      await this.releaseHeld(batch);
      if (owned) await this.checkStep(batch);
      if (st.backfill) await this.backfill(batch);
      this.applyAnswered(batch);
      await this.workerStep(batch);
    } catch (error) {
      // SPEC §11.5: on a throw the caller retries with the same cursor.
      for (const action of batch.rollback) action();
      throw error;
    }
    p.n += 1;
    for (const action of batch.commit) action();
    const result = { events: batch.events, cursor: encodeCursor(p) };
    st.memo = [...st.memo, { cursor: key, result }].slice(-2);
    return result;
  }

  /** T5 calls this after `reply`: the question stops counting as waiting input. */
  markAnswered(question: QuestionRef): void {
    for (const st of this.sessions.values()) st.answered.add(question);
  }
  /** Aborts long polls; their requests replay from the committed cursor next start. */
  close(): void {
    for (const st of this.sessions.values()) st.inflight?.controller.abort();
  }
  /** Await actual long-poll termination before installing a replacement observer. */
  async closeAndDrain(): Promise<void> {
    this.close();
    await Promise.allSettled(
      [...this.sessions.values()].flatMap((st) =>
        st.inflight ? [st.inflight.promise] : [],
      ),
    );
  }
  metrics() {
    return { escalations: this.escalations };
  }

  private state(session: string): SessionState {
    let st = this.sessions.get(session);
    if (!st) {
      st = {
        started: false,
        backfill: false,
        rotate: false,
        known: new Set(),
        pendingSince: new Map(),
        memo: [],
        listedAt: Number.NEGATIVE_INFINITY,
        answersAt: Number.NEGATIVE_INFINITY,
        answered: new Set(),
        readAt: new Map(),
        readSig: new Map(),
        progressAt: new Map(),
        probedAt: new Map(),
        probeTime: new Map(),
        stage: new Map(),
        agentWait: new Map(),
        limited: new Set(),
        txIds: new Map(),
        tasks: new Map(),
        identity: [],
        active: true,
      };
      this.sessions.set(session, st);
    }
    return st;
  }
  private iso(): string {
    return new Date(this.now()).toISOString();
  }
  private log(fields: object, msg: string): void {
    // Codes and ids only: never message bodies, argv or transcript text.
    this.options.logger?.info({ component: 'orca-observe', ...fields }, msg);
  }

  /** Read/consume through T3's CLI; Zod failures become one contract_mismatch event. */
  private async call<T>(
    b: Batch,
    command: string,
    args: string[],
    opts: RunOptions,
    schema: z.ZodType<T>,
  ): Promise<{ ok: true; data: T } | { ok: false; error: PortError | null }> {
    let raw: Record<string, unknown>;
    try {
      raw = (await this.options.cli.run(args, opts)).result;
    } catch (error) {
      if (!(error instanceof PortError)) throw error;
      if (error.category === 'contract_mismatch') {
        this.mismatch(b, command, []);
        return { ok: false, error: null };
      }
      return { ok: false, error };
    }
    const parsed = schema.safeParse(raw);
    if (parsed.success) return { ok: true, data: parsed.data };
    this.mismatch(b, command, issueSummary(parsed.error));
    return { ok: false, error: null };
  }
  /** Every worker-list page: one call returns at most 100 rows (M2-FX13). */
  private async listWorkers(
    b: Batch,
  ): Promise<
    | { ok: true; data: { workers: Worker[] } }
    | { ok: false; error: null | PortError }
  > {
    const workers: Worker[] = [],
      seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.call(
        b,
        'orchestration worker-list',
        ['orchestration', 'worker-list', '--full', ...workerPageArgs(cursor)],
        { kind: 'read', priority: 'worker-list', run: b.run },
        WorkerListSchema,
      );
      if (!page.ok) return page;
      workers.push(...page.data.workers);
      try {
        cursor = workerListCursor(page.data, seen);
      } catch (error) {
        if (!(error instanceof PortError)) throw error;
        this.mismatch(b, 'orchestration worker-list', [error.code]);
        return { ok: false, error: null };
      }
    } while (cursor);
    return { ok: true, data: { workers } };
  }
  private mismatch(b: Batch, command: string, issues: string[]): void {
    if (b.mismatched.has(command)) return;
    b.mismatched.add(command);
    b.events.push({
      type: 'runtime.contract_mismatch',
      externalKey: `orca:contract_mismatch:${b.run}:${command}:${b.p.n}`,
      occurredAt: this.iso(),
      command,
      issues,
    });
  }
  /** identity → ensure+rotate; hijacked → ownership; transient → retry later; else throw. */
  private async recover(b: Batch, error: PortError | null): Promise<void> {
    if (!error) return;
    if (error.category === 'identity') {
      await this.options.identity.ensure({ force: true });
      b.st.rotate = true;
      b.st.backfill = true;
      return;
    }
    if (error.category === 'hijacked') {
      await this.options.identity.checkOwnership(b.run, { force: true });
      return;
    }
    if (error.category === 'transient' || error.category === 'permanent') {
      this.log({ run: b.run, code: error.code }, 'Orca read failed; retrying');
      return;
    }
    throw error;
  }

  private async identityStep(b: Batch): Promise<boolean> {
    let owned: boolean;
    try {
      await this.options.identity.ensure();
      owned = (await this.options.identity.checkOwnership(b.run)) === 'owned';
    } catch (error) {
      if (!(error instanceof PortError)) throw error;
      this.log({ run: b.run, code: error.code }, 'Identity check failed');
      owned = false;
    }
    for (const event of this.options.identity.drainEvents()) {
      if (event.type === 'runtime.identity_restored') {
        // The old shim's receipts and long polls are gone: rotate and backfill.
        for (const [run, st] of this.sessions) {
          st.inflight?.controller.abort();
          st.inflight = undefined;
          st.rotate = true;
          st.backfill = true;
          if (event.runs.includes(run)) st.identity.push(event);
        }
        if (!event.runs.length) b.st.identity.push(event);
      } else if (event.type === 'runtime.identity_hijacked') {
        this.state(event.run).identity.push(event);
      } else b.st.identity.push(event);
    }
    const identity = b.st.identity.splice(0);
    b.events.push(...identity);
    // A failed batch hands its identity events to the next one.
    b.rollback.push(() => b.st.identity.unshift(...identity));
    return owned;
  }

  private async checkStep(b: Batch): Promise<void> {
    const { st, p } = b;
    if (st.rotate) {
      st.rotate = false;
      b.rollback.push(() => void (st.rotate = true));
      p.check.requestId = this.chain(st, p.check.requestId);
    }
    const id = p.check.requestId;
    if (st.inflight && st.inflight.requestId !== id) {
      // A cursor older than the memo: drop the newer poll and recover its mail.
      st.inflight.controller.abort();
      st.inflight = undefined;
      st.backfill = true;
    }
    if (!st.inflight) {
      if (!st.known.has(id)) {
        const state = await this.receipt(b, id);
        if (state === 'unknown') return;
        if (state === 'pending') {
          const since = st.pendingSince.get(id) ?? this.now();
          st.pendingSince.set(id, since);
          if (this.now() - since < 2 * this.checkTimeout()) return;
        }
        if (state === 'absent' || state === 'pending') {
          st.pendingSince.delete(id);
          p.check.requestId = this.chain(st, id);
          st.backfill = true;
          return this.checkStep(b);
        }
      }
      st.known.add(id);
      st.inflight = this.startCheck(b.run, id);
    }
    const inflight = st.inflight;
    const settled =
      inflight.settled ??
      (await Promise.race([
        inflight.promise,
        this.wait(this.options.observeWaitMs ?? 250).then(() => undefined),
      ]));
    if (!settled) return;
    b.commit.push(() => {
      if (st.inflight === inflight) st.inflight = undefined;
    });
    if (!settled.ok) {
      const error = settled.error;
      if (!(error instanceof PortError)) throw error;
      if (error.category === 'contract_mismatch') {
        this.mismatch(b, 'orchestration check', []);
        p.check.requestId = this.chain(st, id);
        st.backfill = true;
        return;
      }
      // Transient: the same request id is reissued (a completed one replays).
      if (error.category === 'transient') {
        return this.recover(b, error);
      }
      if (error.category === 'identity' || error.category === 'hijacked')
        return this.recover(b, error);
      throw error;
    }
    const parsed = CheckResultSchema.safeParse(settled.result);
    if (!parsed.success) {
      this.mismatch(b, 'orchestration check', issueSummary(parsed.error));
      p.check.requestId = this.chain(st, id);
      st.backfill = true;
      return;
    }
    const result = parsed.data;
    this.log(
      {
        run: b.run,
        messages: result.messages.length,
        timedOut: !!result.timedOut,
      },
      'Check batch',
    );
    for (const message of result.messages) await this.ingest(b, message);
    // A completed request id replays forever; chain to the next one.
    p.check.requestId = this.chain(st, id);
    // Check messages have no sequence: learn lastSeq from the inbox.
    if (result.messages.length) st.backfill = true;
  }
  /** Ids generated in this process were never issued before: no receipt lookup. */
  private chain(st: SessionState, previous: string): string {
    const id = nextCheckId(previous);
    st.known.add(id);
    return id;
  }
  private checkTimeout(): number {
    return this.options.checkTimeoutMs ?? 30_000;
  }
  private startCheck(run: string, requestId: string): Inflight {
    const controller = new AbortController();
    const inflight: Inflight = {
      requestId,
      controller,
      promise: undefined as unknown as Promise<Outcome>,
    };
    inflight.promise = this.options.cli
      .run(
        [
          'orchestration',
          'check',
          '--wait',
          '--timeout-ms',
          String(this.checkTimeout()),
        ],
        {
          kind: 'consume',
          run,
          requestId,
          priority: 'consume',
          timeoutMs: this.checkTimeout() + 20_000,
          signal: controller.signal,
        },
      )
      .then(
        ({ result }): Outcome => ({ ok: true, result: result as CheckResult }),
        (error: unknown): Outcome => ({ ok: false, error }),
      )
      .then((outcome) => (inflight.settled = outcome));
    return inflight;
  }
  private async receipt(
    b: Batch,
    requestId: string,
  ): Promise<'completed' | 'pending' | 'absent' | 'unknown'> {
    const shown = await this.call(
      b,
      'orchestration request-show',
      ['orchestration', 'request-show', '--request', requestId],
      { kind: 'read', priority: 'consume' },
      RequestShowSchema,
    );
    if (!shown.ok) {
      await this.recover(b, shown.error);
      return 'unknown';
    }
    const state = shown.data.state;
    // completed → reissuing the same id replays the same batch (same deliveryId).
    return state === 'completed' || state === 'pending' ? state : 'absent';
  }

  /** Newest-first inbox read down to `sequence ≤ lastSeq`; growing limit as needed. */
  private async backfill(b: Batch): Promise<void> {
    let limit = 50;
    for (;;) {
      const inbox = await this.call(
        b,
        'orchestration inbox',
        ['orchestration', 'inbox', '--full', '--limit', String(limit)],
        {
          kind: 'read',
          priority: 'consume',
          mailbox: { kind: 'run', id: b.run },
        },
        InboxResultSchema,
      );
      if (!inbox.ok) return this.recover(b, inbox.error);
      const messages = inbox.data.messages;
      const reached =
        messages.length < limit ||
        messages.some((m) => m.sequence <= b.p.lastSeq);
      if (!reached && limit < MAX_INBOX) {
        limit = Math.min(limit * 4, MAX_INBOX);
        continue;
      }
      if (!reached)
        this.log({ run: b.run, limit }, 'Inbox backfill reached its limit');
      const fresh = messages
        .filter((m) => m.sequence > b.p.lastSeq)
        .sort((x, y) => x.sequence - y.sequence);
      for (const message of fresh) await this.ingest(b, message);
      b.p.lastSeq = Math.max(b.p.lastSeq, ...fresh.map((m) => m.sequence));
      b.commit.push(() => void (b.st.backfill = false));
      return;
    }
  }

  private async ingest(b: Batch, message: MailMessage): Promise<void> {
    if (b.messages.has(message.id)) return;
    b.messages.add(message.id);
    if (message.type === 'escalation') {
      // SPEC §6.4: never `error`, never resent; log and count only.
      this.escalations++;
      this.log(
        { run: b.run, dispatch: dispatchOf(message), message: message.id },
        'Escalation recorded without an event',
      );
      return;
    }
    if (message.type !== 'question' && message.type !== 'worker_done') return;
    const dispatch = dispatchOf(message);
    if (!dispatch) {
      // M2-FX12 D11: the cursor commits past this message with the batch, so
      // a silent drop loses it for good. Pause visibly instead (§11.5).
      this.log(
        { run: b.run, message: message.id, type: message.type },
        'Mail without a dispatch',
      );
      this.mismatch(b, 'orchestration mail payload', ['dispatchId: missing']);
      return;
    }
    const resolved = await this.resolve(b, dispatch, payloadOf(message).taskId);
    if (resolved.kind === 'unmanaged') {
      this.log({ run: b.run, dispatch }, 'Mail from an unmanaged dispatch');
      return;
    }
    const event = messageEvent(
      message,
      (resolved.kind === 'agent' ? resolved.agent : dispatch) as AgentRef,
      this.now(),
    );
    if (!event) return;
    // A check replay and an inbox backfill may both return a message across batches.
    if (b.p.held.some((h) => heldKey(h) === event.externalKey)) return;
    if (
      message.type === 'question' &&
      !b.p.questions.some((q) => q.id === message.id)
    )
      b.p.questions.push({
        id: message.id,
        dispatch,
        since: event.occurredAt,
      });
    if (resolved.kind === 'held') {
      const { commandId } = resolved;
      b.p.held.push(
        event.type === 'agent.question'
          ? {
              dispatch,
              commandId,
              question: { id: message.id, occurredAt: event.occurredAt },
            }
          : { dispatch, commandId, event },
      );
      return;
    }
    if (message.type === 'worker_done') this.clearQuestions(b, resolved.agent);
    b.events.push(event);
  }
  private clearQuestions(b: Batch, agent: AgentRef): void {
    b.p.questions = b.p.questions.filter(
      (q) => (this.options.ledger.agentFor(q.dispatch) ?? q.dispatch) !== agent,
    );
  }

  /** Pending spawn → held; aio: title of ours → agent; anything else → unmanaged. */
  private async resolve(
    b: Batch,
    dispatch: string,
    taskId: string | undefined,
    worker?: Worker,
  ): Promise<Resolution> {
    const ledger = this.options.ledger;
    const agent = ledger.agentFor(dispatch);
    if (agent) return { kind: 'agent', agent };
    if (worker && worker.projection.parent != null)
      return { kind: 'unmanaged' };
    // D10: Orca's own follow-up turn of a managed, kept-open worker, only from
    // our dispatch in this run on the same terminal.
    const origin = worker?.resource?.originDispatchId ?? worker?.followUpOf;
    const inherited =
      worker && origin
        ? ledger.adopt(dispatch, origin, {
            run: worker.runId,
            terminal: worker.agentTerminalHandle ?? worker.terminal,
            originTerminal: b.terminals.get(origin),
          })
        : undefined;
    if (inherited) return { kind: 'agent', agent: inherited };
    const title = taskId ? await this.title(b, taskId) : undefined;
    const token = title ? markerToken(title) : undefined;
    if (!token) {
      // Mail can arrive before the worker row is seen: the rebuilt ledger
      // links native follow-ups to their managed origin.
      if (!worker && !b.rebuilt) {
        b.rebuilt = true;
        await this.rebuildLedger(b);
        const rebuilt = ledger.agentFor(dispatch);
        if (rebuilt) return { kind: 'agent', agent: rebuilt };
      }
      return title === undefined
        ? { kind: 'unmanaged' }
        : { kind: 'unmanaged', title };
    }
    const entry = ledger.byCommand(token);
    const commandId = entry?.commandId ?? token;
    if (entry?.state === 'pending' && entry.run === b.run)
      return { kind: 'held', commandId };
    if (this.options.ownsCommand && !this.options.ownsCommand(commandId))
      return { kind: 'unmanaged', title };
    if (!b.rebuilt) {
      b.rebuilt = true;
      await this.rebuildLedger(b);
      const rebuilt = ledger.agentFor(dispatch);
      if (rebuilt) return { kind: 'agent', agent: rebuilt };
    }
    return { kind: 'unmanaged', title };
  }
  private async title(b: Batch, taskId: string): Promise<string | undefined> {
    if (!b.st.tasks.has(taskId) && !b.tasksFetched) {
      b.tasksFetched = true;
      const tasks = await this.call(
        b,
        'orchestration task-list',
        ['orchestration', 'task-list'],
        { kind: 'read', priority: 'worker-list', run: b.run },
        TaskListSchema,
      );
      if (tasks.ok)
        for (const task of tasks.data.tasks)
          b.st.tasks.set(task.id, task.title);
      else await this.recover(b, tasks.error);
    }
    return b.st.tasks.get(taskId);
  }
  /** The ledger is a rebuildable cache (§11.5): complete worker-list and task-list. */
  private async rebuildLedger(b: Batch): Promise<void> {
    const workers = await this.listWorkers(b);
    if (!workers.ok) return this.recover(b, workers.error);
    const tasks = [...b.st.tasks].map(([id, title]) => ({ id, title }));
    try {
      this.options.ledger.rebuild(b.run, workers.data, { tasks });
    } catch (error) {
      if (!(error instanceof PortError)) throw error;
      this.log({ run: b.run, code: error.code }, 'Ledger rebuild refused');
    }
  }
  private async releaseHeld(b: Batch): Promise<void> {
    const keep: HeldItem[] = [];
    const release: { item: HeldItem; agent: AgentRef }[] = [];
    for (const item of b.p.held) {
      const agent = this.options.ledger.agentFor(item.dispatch);
      if (agent) {
        release.push({ item, agent });
        continue;
      }
      const entry = this.options.ledger.byCommand(item.commandId);
      if (entry?.state === 'pending') {
        keep.push(item);
        continue;
      }
      const resolved = await this.resolve(b, item.dispatch, undefined);
      if (resolved.kind === 'agent')
        release.push({ item, agent: resolved.agent });
      else
        this.log(
          { run: b.run, dispatch: item.dispatch },
          'Held events dropped: spawn did not start',
        );
    }
    const ids = new Set(
      release.flatMap(({ item }) =>
        'question' in item ? [item.question.id] : [],
      ),
    );
    const bodies = ids.size ? await this.heldQuestions(b, ids) : new Map();
    // A failed inbox read keeps everything held, in order, for the next batch.
    if (!bodies) return;
    for (const { item, agent } of release) {
      if ('event' in item) {
        if (item.event.type === 'agent.done') this.clearQuestions(b, agent);
        b.events.push({ ...item.event, agent } as RuntimeEvent);
        continue;
      }
      const message = bodies.get(item.question.id);
      if (!message)
        this.log(
          { run: b.run, dispatch: item.dispatch, message: item.question.id },
          'Held question body not found in the inbox',
        );
      b.events.push(
        (message && messageEvent(message, agent, this.now())) ?? {
          type: 'agent.question',
          agent,
          externalKey: heldKey(item),
          occurredAt: item.question.occurredAt,
          question: questionRef(item.question.id),
          body: '',
        },
      );
    }
    b.p.held = keep;
  }
  /** Held questions persist ids only: refetch their bodies from the run inbox. */
  private async heldQuestions(
    b: Batch,
    ids: ReadonlySet<string>,
  ): Promise<Map<string, MailMessage> | undefined> {
    let limit = 50;
    for (;;) {
      const inbox = await this.call(
        b,
        'orchestration inbox',
        ['orchestration', 'inbox', '--full', '--limit', String(limit)],
        {
          kind: 'read',
          priority: 'consume',
          mailbox: { kind: 'run', id: b.run },
        },
        InboxResultSchema,
      );
      if (!inbox.ok) {
        await this.recover(b, inbox.error);
        return undefined;
      }
      const messages = inbox.data.messages;
      const found = new Map(
        messages.filter((m) => ids.has(m.id)).map((m) => [m.id, m]),
      );
      if (
        found.size === ids.size ||
        messages.length < limit ||
        limit >= MAX_INBOX
      )
        return found;
      limit = Math.min(limit * 4, MAX_INBOX);
    }
  }

  private applyAnswered(b: Batch): void {
    const answered = [...b.st.answered];
    if (!answered.length) return;
    b.p.questions = b.p.questions.filter((q) => !b.st.answered.has(q.id));
    b.commit.push(() => {
      for (const id of answered) b.st.answered.delete(id);
    });
  }
  /** Replies go to the dispatch mailbox with `thread_id` = question id (P6). */
  private async refreshAnswers(b: Batch): Promise<void> {
    if (!b.p.questions.length || this.now() - b.st.answersAt < 10_000) return;
    b.st.answersAt = this.now();
    for (const dispatch of new Set(b.p.questions.map((q) => q.dispatch))) {
      const inbox = await this.call(
        b,
        'orchestration inbox',
        ['orchestration', 'inbox', '--full', '--limit', '20'],
        {
          kind: 'read',
          priority: 'worker-list',
          mailbox: { kind: 'dispatch', id: dispatch },
        },
        InboxResultSchema,
      );
      if (!inbox.ok) {
        await this.recover(b, inbox.error);
        continue;
      }
      const threads = new Set(
        inbox.data.messages
          .filter((m) => isAnswer(m, b.run))
          .map((m) => m.thread_id),
      );
      b.p.questions = b.p.questions.filter((q) => !threads.has(q.id));
    }
  }

  /**
   * How long a live agent's transcript may go unread when its worker-list
   * signature does not change: Orca 1.4.272 leaves `evidence.lastObservedAt`
   * empty, so a long turn never changed the signature and its activity was
   * read only at the next state change (M5-T11b: up to 22 min late).
   * Pressure (the 120 calls/min limiter) stretches it, never removes it.
   */
  private rereadMs(state: AgentState, pressured: boolean): number {
    const live = ['working', 'waiting_input', 'starting'].includes(state);
    return live ? (pressured ? 30_000 : 15_000) : pressured ? 120_000 : 30_000;
  }

  private async workerStep(b: Batch): Promise<void> {
    const { st, p } = b;
    const pressured = this.options.pressured?.() ?? false;
    const interval = st.active ? (pressured ? 4_000 : 2_000) : 10_000;
    if (this.now() - st.listedAt < interval) return;
    st.listedAt = this.now();
    await this.refreshAnswers(b);
    const listed = await this.listWorkers(b);
    if (!listed.ok) return this.recover(b, listed.error);
    const groups = new Map<AgentRef, Worker[]>();
    for (const worker of listed.data.workers) {
      const terminal = worker.agentTerminalHandle ?? worker.terminal;
      b.terminals.set(worker.dispatchId, terminal);
      // D10 adoption needs it after Orca's own turn takes the resource.
      if (worker.runId === b.run)
        this.options.ledger.noteTerminal(worker.dispatchId, terminal);
    }
    for (const worker of listed.data.workers) {
      if (worker.runId !== b.run) continue;
      if (p.seen[worker.dispatchId] === 'unmanaged') continue;
      const resolved = await this.resolve(
        b,
        worker.dispatchId,
        worker.taskId,
        worker,
      );
      if (resolved.kind === 'held') continue;
      if (resolved.kind === 'unmanaged') {
        p.seen[worker.dispatchId] = 'unmanaged';
        const parent = worker.projection.parent;
        const parentDispatch =
          typeof parent === 'string'
            ? parent
            : parent && typeof parent === 'object' && 'dispatchId' in parent
              ? String((parent as { dispatchId: unknown }).dispatchId)
              : undefined;
        const agentKind = worker.projection.provider?.id ?? undefined;
        b.events.push({
          type: 'agent.unmanaged',
          externalKey: `orca:unmanaged:${worker.dispatchId}`,
          occurredAt: this.iso(),
          dispatch: worker.dispatchId,
          ...(parentDispatch ? { parentDispatch } : {}),
          ...(agentKind ? { agentKind } : {}),
          ...(resolved.title === undefined ? {} : { title: resolved.title }),
        });
        continue;
      }
      groups.set(resolved.agent, [
        ...(groups.get(resolved.agent) ?? []),
        worker,
      ]);
    }
    let active = false;
    const reads: { agent: AgentRef; worker: Worker }[] = [];
    for (const [agent, workers] of groups) {
      const worker = currentDispatch(workers);
      const previous = p.seen[agent];
      if (previous === 'exited') continue;
      const questions = p.questions.filter(
        (q) =>
          (this.options.ledger.agentFor(q.dispatch) ?? q.dispatch) === agent,
      );
      const stopped =
        this.options.ledger.byDispatch(worker.dispatchId)?.stoppedByBackend ===
        true;
      let state = workerState(
        worker,
        questions.length > 0 || st.agentWait.get(agent) === true,
        stopped,
      );
      if (state !== 'exited') active = true;
      const progress = st.progressAt.get(worker.dispatchId) ?? this.now();
      if (!st.progressAt.has(worker.dispatchId))
        st.progressAt.set(worker.dispatchId, progress);
      const stalled =
        state === 'working' &&
        this.now() - progress >= (this.options.stallMs ?? 60_000) &&
        st.probedAt.get(worker.dispatchId) !== progress;
      const stage = stageKey(worker);
      const stageChanged = st.stage.get(worker.dispatchId) !== stage;
      st.stage.set(worker.dispatchId, stage);
      // Probe only on a displayed change, a stall, or to see agentWait clear.
      const recheck =
        st.agentWait.get(agent) === true &&
        this.now() - (st.probeTime.get(worker.dispatchId) ?? -Infinity) >=
          10_000;
      if (
        state !== 'exited' &&
        state !== 'stopped' &&
        (stageChanged || state !== previous || stalled || recheck)
      ) {
        st.probedAt.set(worker.dispatchId, progress);
        st.probeTime.set(worker.dispatchId, this.now());
        const waiting = await this.probe(b, agent, worker.dispatchId);
        if (waiting !== undefined) {
          st.agentWait.set(agent, waiting);
          state = workerState(worker, questions.length > 0 || waiting, stopped);
        }
      }
      if (state !== previous)
        this.emitState(b, agent, worker, state, questions);
      const sig = activitySignature(worker);
      const unreadFor =
        this.now() - (st.readAt.get(worker.dispatchId) ?? -Infinity);
      if (
        st.readSig.get(worker.dispatchId) !== sig ||
        (state !== 'stopped' && unreadFor >= this.rereadMs(state, pressured))
      )
        reads.push({ agent, worker });
    }
    st.active = active || p.held.length > 0;
    await this.readTranscripts(b, reads, pressured);
  }
  private emitState(
    b: Batch,
    agent: AgentRef,
    worker: Worker,
    state: AgentState,
    questions: CursorPayload['questions'],
  ): void {
    const base = { agent, occurredAt: this.iso() };
    b.p.seen[agent] = state;
    if (state === 'exited') {
      this.clearQuestions(b, agent);
      b.events.push({
        ...base,
        type: 'agent.exited',
        externalKey: `orca:exited:${agent}`,
        reason: worker.terminalState === 'released' ? 'released' : 'exited',
      });
      return;
    }
    if (state === 'stopped') {
      b.events.push({
        ...base,
        type: 'agent.stopped',
        externalKey: `orca:stopped:${agent}:${worker.dispatchId}`,
      });
      return;
    }
    const since = questions.map((q) => q.since).sort()[0];
    b.events.push({
      ...base,
      type: 'agent.status',
      externalKey: `orca:status:${agent}:${state}:${b.run}:${b.p.n}`,
      state,
      ...(state === 'waiting_input' && since ? { waitingSince: since } : {}),
    });
  }
  /** `worker-show` agentWait: waiting input and S26 evidence. */
  private async probe(
    b: Batch,
    agent: AgentRef,
    dispatch: string,
  ): Promise<boolean | undefined> {
    const shown = await this.call(
      b,
      'orchestration worker-show',
      ['orchestration', 'worker-show', '--dispatch', dispatch, '--full'],
      { kind: 'read', priority: 'worker-list' },
      WorkerShowSchema,
    );
    if (!shown.ok) {
      await this.recover(b, shown.error);
      return undefined;
    }
    const agentWait = shown.data.observation?.agentWait ?? null;
    const limited = detectRateLimit({ agentWait });
    if (limited)
      this.rateLimited(b, agent, dispatch, limited, `ws:${this.now()}`);
    return agentWait !== null && !limited;
  }
  private rateLimited(
    b: Batch,
    agent: AgentRef,
    dispatch: string,
    found: NonNullable<ReturnType<typeof detectRateLimit>>,
    marker: string,
  ): void {
    if (b.st.limited.has(dispatch)) return;
    b.commit.push(() => b.st.limited.add(dispatch));
    b.events.push({
      type: 'agent.rate_limited',
      agent,
      externalKey: `orca:rate_limited:${dispatch}:${marker}`,
      occurredAt: this.iso(),
      evidence: found.evidence,
      ...(found.resetsAt ? { resetsAt: found.resetsAt } : {}),
    });
  }

  private async readTranscripts(
    b: Batch,
    reads: { agent: AgentRef; worker: Worker }[],
    pressured: boolean,
  ): Promise<void> {
    const minMs = pressured ? 10_000 : 3_000;
    const due = reads.filter(
      ({ worker }) =>
        b.p.seen[`tx:${worker.dispatchId}`] !== 'none' &&
        this.now() - (b.st.readAt.get(worker.dispatchId) ?? -Infinity) >= minMs,
    );
    let next = 0;
    const lane = async () => {
      while (next < due.length) {
        const item = due[next++]!;
        await this.readOne(b, item.agent, item.worker, false);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(READ_CONCURRENCY, due.length) }, lane),
    );
  }
  private async readOne(
    b: Batch,
    agent: AgentRef,
    worker: Worker,
    restarted: boolean,
  ): Promise<void> {
    const dispatch = worker.dispatchId;
    const { st, p } = b;
    st.readAt.set(dispatch, this.now());
    const position = p.tx[dispatch];
    const read = await this.call(
      b,
      'orchestration worker-read',
      [
        'orchestration',
        'worker-read',
        '--dispatch',
        dispatch,
        '--source',
        'transcript',
        '--limit',
        '200',
        '--full',
        ...(position ? ['--cursor', position] : []),
      ],
      { kind: 'read', priority: 'worker-read' },
      WorkerReadSchema,
    );
    const changed =
      (!read.ok && read.error?.code === 'source_changed') ||
      (read.ok && read.data.fallbackReason === 'source_changed');
    if (changed) {
      b.events.push({
        type: 'agent.degraded',
        agent,
        externalKey: `orca:degraded:${dispatch}:source_changed:${b.p.n}`,
        occurredAt: this.iso(),
        reason: 'source_changed',
      });
      delete p.tx[dispatch];
      // Re-read from the start; message ids deduplicate (SPEC §6.4).
      if (!restarted) return this.readOne(b, agent, worker, true);
      return;
    }
    if (!read.ok) return this.recover(b, read.error);
    const data = read.data;
    const sig = activitySignature(worker);
    b.commit.push(() => st.readSig.set(dispatch, sig));
    if (data.source !== 'transcript') {
      // Never parse terminal output instead (SPEC §6.4).
      p.seen[`tx:${dispatch}`] = 'none';
      b.events.push({
        type: 'agent.degraded',
        agent,
        externalKey: `orca:degraded:${dispatch}:no_transcript_source`,
        occurredAt: this.iso(),
        reason: 'no_transcript_source',
      });
      return;
    }
    if (data.contentComplete === false && !p.seen[`clip:${dispatch}`]) {
      p.seen[`clip:${dispatch}`] = 'clipped';
      b.events.push({
        type: 'agent.degraded',
        agent,
        externalKey: `orca:degraded:${dispatch}:transcript_clipped`,
        occurredAt: this.iso(),
        reason: 'transcript_clipped',
      });
    }
    if (data.cursor) p.tx[dispatch] = data.cursor;
    const messages = Array.isArray(data.transcript)
      ? data.transcript
      : (data.transcript?.messages ?? []);
    const seen = st.txIds.get(dispatch) ?? new Set<string>();
    const fresh = messages.filter((m) => !seen.has(m.id));
    if (fresh.length) {
      b.commit.push(() => {
        st.txIds.set(dispatch, seen);
        for (const m of fresh) seen.add(m.id);
        // Bounded: externalKey dedup in the event store remains authoritative.
        if (seen.size > 2_000)
          for (const id of [...seen].slice(0, 1_000)) seen.delete(id);
        st.progressAt.set(dispatch, this.now());
      });
    }
    let lastAssistant: string | undefined;
    for (const message of fresh) {
      if (!['assistant', 'user', 'tool'].includes(message.role)) continue;
      const blocks = rawBlocks(message);
      b.events.push({
        type: 'agent.output',
        agent,
        externalKey: `orca:tx:${dispatch}:${message.id}`,
        occurredAt: isoOf(message.timestamp, this.now()),
        messageId: message.id,
        role: message.role as 'assistant' | 'user' | 'tool',
        blocks,
      });
      if (message.role === 'assistant') lastAssistant = lastText(message);
    }
    if (lastAssistant === undefined) return;
    // The tail stays in memory for recognition only; it is never stored or logged.
    const found = detectRateLimit({ lastMessage: lastAssistant });
    const last = fresh.findLast((m) => m.role === 'assistant')!;
    if (found) this.rateLimited(b, agent, dispatch, found, last.id);
    else if (st.limited.has(dispatch))
      b.commit.push(() => st.limited.delete(dispatch));
  }
}
