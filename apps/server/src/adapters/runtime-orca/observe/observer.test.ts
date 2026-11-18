import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeCursor, SessionRef } from '../../../ports/refs.js';
import {
  type RuntimeEvent,
  RuntimeEventSchema,
} from '../../../ports/runtime-events.js';
import { CliScheduler, CwdGuard, DefaultOrcaCli } from '../index.js';
import type { ExecRequest } from '../cli/types.js';
import { DispatchLedger } from '../ledger.js';
import { ORCA_TITLE_MAX } from '../marker.js';
import { marker } from '../methods/context.js';
import type { AdapterState } from '../state.js';
import { decodeCursor, questionRef } from '../refs.js';
import { CursorPayloadSchema, firstCheckId, nextCheckId } from './cursor.js';
import { OrcaObserver } from './observer.js';

const RUN = 'run_3d70ed17e5de';
const SHIM = 'term_00000000-0000-4000-8000-000000000001';
const session = RUN as SessionRef;
const LIMIT_TEXT = 'Claude usage limit reached|1794990000. secret-tail-xyz';

type Mail = {
  id: string;
  type: string;
  to: string;
  dispatch?: string;
  task?: string;
  thread?: string;
  outcome?: string;
  sequence: number;
  read: boolean;
};
type W = {
  dispatchId: string;
  taskId: string;
  workerState?: string;
  terminalState?: string | null;
  verdict?: string;
  activity?: string;
  observedAt?: number;
  owner?: string | null;
  origin?: string | null;
  parent?: unknown;
  provider?: string;
};
type TxMessage = { id: string; role: string; text: string };
const ok = (result: unknown) => JSON.stringify({ ok: true, result });
const err = (code: string) => JSON.stringify({ ok: false, error: { code } });
const flag = (args: readonly string[], name: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;

/** Orca 1.4.259 behaviour (fixture shapes) over a small mailbox/worker model. */
class World {
  seq = 600;
  mail: Mail[] = [];
  receipts = new Map<string, unknown>();
  pendingReceipts = new Set<string>();
  parked: { requestId: string; resolve: (stdout: string) => void } | null =
    null;
  workers: W[] = [];
  tasks: { id: string; title: string }[] = [];
  agentWait = new Map<string, unknown>();
  transcripts = new Map<string, TxMessage[]>();
  sourceChanged = new Set<string>();
  noTranscript = new Set<string>();
  clipped = new Set<string>();
  calls: string[][] = [];
  failNext = new Map<string, string>();
  /** Drops consuming-check responses (crash after Orca consumed). */
  loseResponses = false;

  post(m: Omit<Mail, 'sequence' | 'read' | 'to'> & { to?: string }): Mail {
    const mail = { to: `run:${RUN}`, ...m, sequence: ++this.seq, read: false };
    this.mail.push(mail);
    this.flush();
    return mail;
  }
  private wire(m: Mail, withSeq: boolean) {
    return {
      id: m.id,
      run_id: RUN,
      from_handle: m.dispatch ? `dispatch:${m.dispatch}` : 'run:' + RUN,
      to_handle: m.to,
      subject: 'aio subject',
      body: m.type === 'question' ? 'raw question body' : 'body',
      type: m.type,
      thread_id: m.thread ?? (m.type === 'question' ? m.id : null),
      payload:
        m.type === 'status'
          ? null
          : JSON.stringify({
              taskId: m.task,
              dispatchId: m.dispatch,
              ...(m.outcome ? { outcome: m.outcome } : {}),
              ...(m.type === 'question' ? { question: `Q ${m.id}?` } : {}),
              ...(m.type === 'escalation' ? { stopReason: 'finished' } : {}),
            }),
      created_at: '2026-11-18T05:50:51Z',
      delivered_at: null,
      ...(withSeq ? { read: m.read ? 1 : 0, sequence: m.sequence } : {}),
    };
  }
  private batch(requestId: string, timedOut: boolean) {
    const unread = this.mail.filter((m) => m.to === `run:${RUN}` && !m.read);
    for (const m of unread) m.read = true;
    const result = {
      runId: RUN,
      deliveryId: `d-${requestId}`,
      messages: unread.map((m) => this.wire(m, false)),
      count: unread.length,
      timedOut,
      cancelled: false,
      connectionLost: false,
      mutation: { requestId, replayed: false },
    };
    this.receipts.set(requestId, result);
    return result;
  }
  flush(): void {
    const parked = this.parked;
    if (!parked) return;
    if (!this.mail.some((m) => m.to === `run:${RUN}` && !m.read)) return;
    this.parked = null;
    const result = this.batch(parked.requestId, false);
    parked.resolve(this.loseResponses ? err('ECONNRESET') : ok(result));
  }
  timeout(): void {
    const parked = this.parked;
    if (!parked) return;
    this.parked = null;
    parked.resolve(ok(this.batch(parked.requestId, true)));
  }
  async respond(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    const words = args.slice(0, 2).join(' ');
    const failure = this.failNext.get(words);
    if (failure) {
      this.failNext.delete(words);
      return err(failure);
    }
    switch (words) {
      case 'orchestration check': {
        const id = flag(args, '--retry-request')!;
        const prior = this.receipts.get(id);
        if (prior)
          return ok({
            ...(prior as object),
            mutation: { requestId: id, replayed: true },
          });
        if (this.mail.some((m) => m.to === `run:${RUN}` && !m.read)) {
          const result = this.batch(id, false);
          return this.loseResponses ? err('ECONNRESET') : ok(result);
        }
        return new Promise((resolve) => {
          this.parked = { requestId: id, resolve };
        });
      }
      case 'orchestration request-show': {
        const id = flag(args, '--request')!;
        if (this.pendingReceipts.has(id))
          return ok({ requestId: id, state: 'pending' });
        return ok({
          requestId: id,
          state: this.receipts.has(id) ? 'completed' : 'absent',
        });
      }
      case 'orchestration inbox': {
        const target = flag(args, '--terminal')!;
        const limit = Number(flag(args, '--limit'));
        const messages = this.mail
          .filter((m) => m.to === target)
          .sort((a, b) => b.sequence - a.sequence)
          .slice(0, limit)
          .map((m) => this.wire(m, true));
        return ok({ messages, count: messages.length });
      }
      case 'orchestration task-list':
        return ok({ tasks: this.tasks.map((t) => ({ ...t, runId: RUN })) });
      case 'orchestration worker-list':
        return ok({
          workers: this.workers.map((w) => ({
            dispatchId: w.dispatchId,
            taskId: w.taskId,
            runId: RUN,
            workerState: w.workerState ?? 'ready',
            dispatchStatus: 'dispatched',
            agentTerminalHandle: 'term_x',
            terminalState: w.terminalState ?? 'retained',
            coordinatedFrom: null,
            resource:
              w.owner === null
                ? null
                : {
                    ownerDispatchId: w.owner ?? w.dispatchId,
                    originDispatchId: w.origin ?? w.dispatchId,
                    retainedReason: 'user_requested',
                  },
            projection: {
              dispatchId: w.dispatchId,
              parent: w.parent ?? null,
              provider: { id: w.provider ?? 'claude', model: 'm' },
              stage: {
                worker: w.workerState ?? 'ready',
                activity: w.activity ?? 'working',
              },
              liveness: { verdict: w.verdict ?? 'live' },
              evidence: { lastObservedAt: w.observedAt ?? 1 },
            },
          })),
        });
      case 'orchestration worker-show':
        return ok({
          observation: {
            status: 'live',
            agentWait: this.agentWait.get(flag(args, '--dispatch')!) ?? null,
          },
        });
      case 'orchestration worker-read': {
        const dispatch = flag(args, '--dispatch')!;
        const cursor = flag(args, '--cursor');
        if (cursor && this.sourceChanged.has(dispatch)) {
          this.sourceChanged.delete(dispatch);
          return err('source_changed');
        }
        if (this.noTranscript.has(dispatch))
          return ok({ source: 'terminal', fallbackReason: 'no_transcript' });
        const all = this.transcripts.get(dispatch) ?? [];
        const from = cursor ? Number(cursor) : 0;
        return ok({
          dispatchId: dispatch,
          source: 'transcript',
          cursor: String(all.length),
          contentComplete: !this.clipped.has(dispatch),
          transcript: all.slice(from).map((m) => ({
            id: m.id,
            role: m.role,
            blocks: [{ type: 'text', text: m.text }],
            timestamp: '2026-11-18T05:51:00Z',
          })),
        });
      }
    }
    return err('unexpected_command');
  }
  count(words: string): number {
    return this.calls.filter((c) => c.slice(0, 2).join(' ') === words).length;
  }
}

function memory(): AdapterState {
  const values = new Map<string, unknown>();
  return {
    read: (key) => structuredClone(values.get(key) ?? null),
    write: (key, value) => void values.set(key, structuredClone(value)),
  };
}
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

interface Rig {
  world: World;
  ledger: DispatchLedger;
  observer: OrcaObserver;
  identityEvents: RuntimeEvent[];
  ownership: { value: 'owned' | 'hijacked' };
  clock: { now: number };
  requests: ExecRequest[];
  logs: unknown[];
  fresh(): OrcaObserver;
  observe(cursor: RuntimeCursor | null): Promise<{
    events: RuntimeEvent[];
    cursor: RuntimeCursor;
  }>;
}
async function rig(
  extra: { ownsCommand?: (commandId: string) => boolean } = {},
  world = new World(),
  state = memory(),
): Promise<Rig> {
  const cliCwd = await mkdtemp(join(tmpdir(), 'aio-observe-'));
  dirs.push(cliCwd);
  const clock = { now: 1_800_000_000_000 };
  const requests: ExecRequest[] = [];
  const identityEvents: RuntimeEvent[] = [];
  const ownership = { value: 'owned' as 'owned' | 'hijacked' };
  const logs: unknown[] = [];
  const cli = new DefaultOrcaCli({
    bin: '/bin/orca',
    env: { PATH: '/bin', HOME: '/tmp/home' },
    cwdGuard: new CwdGuard(cliCwd, async () => []),
    scheduler: new CliScheduler(1000, 8),
    identity: {
      argsFor: async (kind, run, context) => {
        if (kind === 'mutate') return ['--from', SHIM];
        if (kind === 'consume') return ['--terminal', SHIM, '--run', run!];
        const mailbox = context?.mailbox;
        return mailbox ? ['--terminal', `${mailbox.kind}:${mailbox.id}`] : [];
      },
    },
    exec: {
      run: async (request) => {
        requests.push(request);
        // Strip the CLI-appended identity/output flags for the world model.
        const stdout = await world.respond(request.args);
        return { stdout, exitCode: 0 };
      },
    },
  });
  const ledger = new DispatchLedger(state);
  const make = () =>
    new OrcaObserver({
      cli,
      ledger,
      identity: {
        ensure: async () => ({ handle: SHIM, restored: false }),
        checkOwnership: async () => ownership.value,
        drainEvents: () => identityEvents.splice(0),
      },
      logger: {
        child() {
          return this;
        },
        info: (o) => void logs.push(o),
        warn: (o) => void logs.push(o),
        error: (o) => void logs.push(o),
      },
      now: () => clock.now,
      observeWaitMs: 30,
      ...extra,
    });
  const r: Rig = {
    world,
    ledger,
    observer: make(),
    identityEvents,
    ownership,
    clock,
    requests,
    logs,
    fresh: () => (r.observer = make()),
    observe: async (cursor) => {
      const result = await r.observer.observe(session, cursor);
      for (const event of result.events) RuntimeEventSchema.parse(event);
      clock.now += 2_500;
      return result;
    },
  };
  return r;
}
/** A started worker: ledger entry, task title and a worker-list row. */
function spawned(r: Rig, dispatch: string, commandId = `cmd-${dispatch}`) {
  const task = `task_${dispatch}`;
  r.ledger.pending({ commandId, run: RUN, keepOpen: true });
  r.ledger.started(commandId, dispatch);
  r.world.tasks.push({ id: task, title: `aio:${commandId} work` });
  r.world.workers.push({ dispatchId: dispatch, taskId: task });
  return task;
}
const keys = (events: RuntimeEvent[]) => events.map((e) => e.externalKey);
const ofType = <T extends RuntimeEvent['type']>(
  events: RuntimeEvent[],
  type: T,
) =>
  events.filter(
    (e): e is Extract<RuntimeEvent, { type: T }> => e.type === type,
  );

describe('OrcaObserver: batches and cursors', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });
  afterEach(() => r.observer.close());

  it('returns a new cursor each batch and keeps receiving while a check is in flight', async () => {
    const task = spawned(r, 'ctx_a');
    const first = await r.observe(null);
    const second = await r.observe(first.cursor);
    expect(second.cursor).not.toBe(first.cursor);
    const a = decodeCursor(first.cursor, CursorPayloadSchema);
    const b = decodeCursor(second.cursor, CursorPayloadSchema);
    expect(b.n).toBe(a.n + 1);
    // The long poll survives across calls: same id, still one check process.
    expect(b.check.requestId).toBe(a.check.requestId);
    expect(r.world.count('orchestration check')).toBe(1);
    r.world.post({ id: 'msg_q1', type: 'question', dispatch: 'ctx_a', task });
    const third = await r.observe(second.cursor);
    expect(ofType(third.events, 'agent.question')).toEqual([
      expect.objectContaining({
        agent: 'ctx_a',
        question: 'msg_q1',
        externalKey: 'orca:msg:msg_q1',
        body: 'Q msg_q1?',
      }),
    ]);
    const c = decodeCursor(third.cursor, CursorPayloadSchema);
    expect(c.check.requestId).toBe(nextCheckId(a.check.requestId));
    // lastSeq comes from the inbox (check messages carry no sequence).
    expect(c.lastSeq).toBe(r.world.seq);
  });

  it('replays the same batch for the same cursor (memo of the last two)', async () => {
    const task = spawned(r, 'ctx_a');
    const first = await r.observe(null);
    r.world.post({
      id: 'msg_d1',
      type: 'worker_done',
      dispatch: 'ctx_a',
      task,
      outcome: 'succeeded',
    });
    const second = await r.observe(first.cursor);
    const again = await r.observe(first.cursor);
    expect(again).toBe(second);
    expect(ofType(again.events, 'agent.done')).toHaveLength(1);
  });

  it('after a crash, request-show completed replays the same messages without loss', async () => {
    const task = spawned(r, 'ctx_a');
    const first = await r.observe(null);
    r.world.post({
      id: 'msg_d1',
      type: 'worker_done',
      dispatch: 'ctx_a',
      task,
      outcome: 'succeeded',
    });
    await r.observe(first.cursor); // consumed, but the batch never committed
    r.observer.close();
    r.fresh();
    const shows = r.world.count('orchestration request-show');
    const replay = await r.observe(first.cursor);
    expect(r.world.count('orchestration request-show')).toBe(shows + 1);
    expect(keys(ofType(replay.events, 'agent.done'))).toEqual([
      'orca:msg:msg_d1',
    ]);
  });

  it('after a crash, an absent receipt rotates the id and backfills from the inbox exactly once', async () => {
    const task = spawned(r, 'ctx_a');
    const first = await r.observe(null);
    const committed = await r.observe(first.cursor);
    // Orca consumed two messages but the response was lost and the receipt pruned.
    r.world.loseResponses = true;
    r.world.post({ id: 'msg_q1', type: 'question', dispatch: 'ctx_a', task });
    r.world.post({
      id: 'msg_d1',
      type: 'worker_done',
      dispatch: 'ctx_a',
      task,
      outcome: 'succeeded',
    });
    r.world.receipts.clear();
    r.world.loseResponses = false;
    r.observer.close();
    r.fresh();
    const recovered = await r.observe(committed.cursor);
    const payload = decodeCursor(recovered.cursor, CursorPayloadSchema);
    const before = decodeCursor(committed.cursor, CursorPayloadSchema);
    const rotated = nextCheckId(before.check.requestId);
    const checks = r.world.calls.filter((c) => c[1] === 'check');
    expect(flagOf(checks.at(-1)!, '--retry-request')).toBe(rotated);
    expect(payload.check.requestId).not.toBe(before.check.requestId);
    const mail = recovered.events.filter((e) =>
      e.externalKey.startsWith('orca:msg:'),
    );
    expect(keys(mail).sort()).toEqual(['orca:msg:msg_d1', 'orca:msg:msg_q1']);
    // Later batches never repeat them.
    const later = await r.observe(recovered.cursor);
    expect(
      later.events.filter((e) => e.externalKey.startsWith('orca:msg:')),
    ).toEqual([]);
  });

  it('backfills at startup with a deterministic first check id', async () => {
    const task = spawned(r, 'ctx_a');
    r.world.post({ id: 'msg_q0', type: 'question', dispatch: 'ctx_a', task });
    const first = await r.observe(null);
    expect(r.world.count('orchestration inbox')).toBeGreaterThanOrEqual(1);
    expect(keys(ofType(first.events, 'agent.question'))).toEqual([
      'orca:msg:msg_q0',
    ]);
    // A never-committed first batch would replay under this deterministic id.
    const shown = r.world.calls.find((c) => c[1] === 'request-show')!;
    expect(flagOf(shown, '--request')).toBe(firstCheckId(RUN));
  });

  it('grows the inbox limit until it reaches lastSeq', async () => {
    const task = spawned(r, 'ctx_a');
    for (let i = 0; i < 70; i++)
      r.world.mail.push({
        id: `msg_old${i}`,
        type: 'status',
        to: `run:${RUN}`,
        sequence: ++r.world.seq,
        read: true,
      });
    r.world.mail.push({
      id: 'msg_q',
      type: 'question',
      to: `run:${RUN}`,
      dispatch: 'ctx_a',
      task,
      sequence: ++r.world.seq,
      read: true,
    });
    const first = await r.observe(null);
    const limits = r.world.calls
      .filter((c) => c[1] === 'inbox' && c.includes(`run:${RUN}`))
      .map((c) => flagOf(c, '--limit'));
    expect(limits).toEqual(['50', '200']);
    expect(decodeCursor(first.cursor, CursorPayloadSchema).lastSeq).toBe(
      r.world.seq,
    );
  });

  it('backfills after identity_restored and rotates the check id', async () => {
    const task = spawned(r, 'ctx_a');
    const first = await r.observe(null);
    r.world.loseResponses = true;
    r.world.post({
      id: 'msg_lost',
      type: 'worker_done',
      dispatch: 'ctx_a',
      task,
      outcome: 'succeeded',
    });
    r.world.loseResponses = false;
    r.identityEvents.push({
      type: 'runtime.identity_restored',
      externalKey: 'orca:identity_restored:x',
      occurredAt: '2026-11-18T06:00:00.000Z',
      newShim: SHIM,
      runs: [RUN],
    });
    const restored = await r.observe(first.cursor);
    expect(ofType(restored.events, 'runtime.identity_restored')).toHaveLength(
      1,
    );
    expect(keys(ofType(restored.events, 'agent.done'))).toEqual([
      'orca:msg:msg_lost',
    ]);
    const a = decodeCursor(first.cursor, CursorPayloadSchema);
    const b = decodeCursor(restored.cursor, CursorPayloadSchema);
    expect(b.check.requestId).not.toBe(a.check.requestId);
  });

  it('does not consume while the run is hijacked but still lists workers', async () => {
    spawned(r, 'ctx_a');
    r.ownership.value = 'hijacked';
    await r.observe(null);
    expect(r.world.count('orchestration check')).toBe(0);
    expect(r.world.count('orchestration worker-list')).toBe(1);
  });

  it('keeps the cursor on a thrown batch and replays its identity events next time', async () => {
    spawned(r, 'ctx_a');
    r.identityEvents.push({
      type: 'runtime.identity_hijacked',
      externalKey: 'orca:identity_hijacked:run:2',
      occurredAt: '2026-11-18T06:00:00.000Z',
      run: RUN,
      coordinatorHandle: 'term_other',
      consumerGeneration: 2,
    });
    r.world.failNext.set('orchestration worker-list', 'request_mismatch');
    await expect(r.observer.observe(session, null)).rejects.toMatchObject({
      category: 'bug',
    });
    const retry = await r.observe(null);
    expect(ofType(retry.events, 'runtime.identity_hijacked')).toHaveLength(1);
  });
});

function flagOf(args: readonly string[], name: string) {
  return args[args.indexOf(name) + 1];
}

describe('OrcaObserver: mapping', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });
  afterEach(() => r.observer.close());

  it('never turns escalations into error; only worker-list liveness exits', async () => {
    const task = spawned(r, 'ctx_a');
    let cursor = (await r.observe(null)).cursor;
    r.world.post({ id: 'msg_e1', type: 'escalation', dispatch: 'ctx_a', task });
    r.world.post({ id: 'msg_e2', type: 'escalation', dispatch: 'ctx_a', task });
    const batch = await r.observe(cursor);
    cursor = batch.cursor;
    expect(batch.events.some((e) => e.type === 'agent.exited')).toBe(false);
    expect(
      batch.events.some(
        (e) => e.type === 'agent.status' && e.state === 'error',
      ),
    ).toBe(false);
    expect(r.observer.metrics().escalations).toBe(2);
    r.world.workers[0]!.terminalState = 'released';
    r.world.workers[0]!.verdict = 'exited';
    const exited = await r.observe(cursor);
    expect(ofType(exited.events, 'agent.exited')).toEqual([
      expect.objectContaining({ agent: 'ctx_a', reason: 'released' }),
    ]);
    const after = await r.observe(exited.cursor);
    expect(ofType(after.events, 'agent.exited')).toEqual([]);
  });

  it('maps worker-list stopped to agent.stopped', async () => {
    spawned(r, 'ctx_a');
    const first = await r.observe(null);
    r.world.workers[0]!.workerState = 'stopped';
    const next = await r.observe(first.cursor);
    expect(ofType(next.events, 'agent.stopped')).toHaveLength(1);
  });

  it('holds a spawn in flight, never flags it unmanaged, and releases after AgentRef', async () => {
    r.ledger.pending({ commandId: 'cmd-s', run: RUN, keepOpen: false });
    r.world.tasks.push({ id: 'task_s', title: 'aio:cmd-s implement' });
    r.world.workers.push({ dispatchId: 'ctx_s', taskId: 'task_s' });
    r.world.post({
      id: 'msg_qs',
      type: 'question',
      dispatch: 'ctx_s',
      task: 'task_s',
    });
    const held = await r.observe(null);
    expect(held.events.filter((e) => e.type.startsWith('agent.'))).toEqual([]);
    expect(decodeCursor(held.cursor, CursorPayloadSchema).held).toHaveLength(1);
    const still = await r.observe(held.cursor);
    expect(still.events.filter((e) => e.type.startsWith('agent.'))).toEqual([]);
    r.ledger.started('cmd-s', 'ctx_s');
    const released = await r.observe(still.cursor);
    expect(ofType(released.events, 'agent.question')).toEqual([
      expect.objectContaining({
        agent: 'ctx_s',
        externalKey: 'orca:msg:msg_qs',
      }),
    ]);
    expect(ofType(released.events, 'agent.unmanaged')).toEqual([]);
    expect(decodeCursor(released.cursor, CursorPayloadSchema).held).toEqual([]);
  });

  it('holds a long engine send id in flight from its 80-char Orca title, never unmanaged (M2-T17 D7)', async () => {
    // Real engine send ids reach ~100 chars; Orca 1.4.259 cuts titles at 80.
    const id =
      '01M7Q3TBDBCY4F0ZFFB9ENP03P/meeting/1/round/1/send/01M7Q3TBDBCY4F0ZFFB9ENP03P/meeting/1/attempt/engineer';
    const full = `${marker(id)} Meeting round 1`;
    const title =
      full.length > ORCA_TITLE_MAX
        ? `${full.slice(0, ORCA_TITLE_MAX - 3)}...`
        : full;
    expect(title.length).toBeLessThanOrEqual(ORCA_TITLE_MAX);
    expect(title.startsWith(`${marker(id)} `)).toBe(true);
    // The legacy raw marker could never fit: it is longer than the cap.
    expect(`aio:${id}`.length).toBeGreaterThan(ORCA_TITLE_MAX);
    r.ledger.pending({ commandId: id, run: RUN, keepOpen: true });
    r.world.tasks.push({ id: 'task_f', title });
    r.world.workers.push({ dispatchId: 'ctx_f', taskId: 'task_f' });
    r.world.post({
      id: 'msg_f',
      type: 'question',
      dispatch: 'ctx_f',
      task: 'task_f',
    });
    const held = await r.observe(null);
    expect(ofType(held.events, 'agent.unmanaged')).toEqual([]);
    expect(decodeCursor(held.cursor, CursorPayloadSchema).held).toHaveLength(1);
    r.ledger.started(id, 'ctx_f');
    const released = await r.observe(held.cursor);
    expect(ofType(released.events, 'agent.unmanaged')).toEqual([]);
    expect(decodeCursor(released.cursor, CursorPayloadSchema).held).toEqual([]);
    // A ledger rebuilt from that title alone still matches the full id.
    const lost = new DispatchLedger({ read: () => null, write: () => {} });
    lost.rebuild(
      RUN,
      { workers: [{ dispatchId: 'ctx_f', taskId: 'task_f', runId: RUN }] },
      { tasks: [{ id: 'task_f', title }] },
    );
    expect(lost.byCommand(id)?.dispatch).toBe('ctx_f');
    expect(lost.isPendingTitle(title)).toBe(false);
  });

  it('persists only the id of a held question and refetches its body on release', async () => {
    r.ledger.pending({ commandId: 'cmd-s', run: RUN, keepOpen: false });
    r.world.tasks.push({ id: 'task_s', title: 'aio:cmd-s implement' });
    r.world.workers.push({ dispatchId: 'ctx_s', taskId: 'task_s' });
    r.world.post({
      id: 'msg_qs',
      type: 'question',
      dispatch: 'ctx_s',
      task: 'task_s',
    });
    const held = await r.observe(null);
    const persisted = Buffer.from(held.cursor, 'base64url').toString('utf8');
    expect(persisted).toContain('msg_qs');
    expect(persisted).not.toContain('Q msg_qs?');
    expect(persisted).not.toContain('raw question body');
    expect(decodeCursor(held.cursor, CursorPayloadSchema).held).toEqual([
      {
        dispatch: 'ctx_s',
        commandId: 'cmd-s',
        question: { id: 'msg_qs', occurredAt: '2026-11-18T05:50:51.000Z' },
      },
    ]);
    r.ledger.started('cmd-s', 'ctx_s');
    // The body refetch fails once: the question stays held and is not dropped.
    r.world.failNext.set('orchestration inbox', 'ECONNRESET');
    const retried = await r.observe(held.cursor);
    expect(ofType(retried.events, 'agent.question')).toEqual([]);
    expect(decodeCursor(retried.cursor, CursorPayloadSchema).held).toHaveLength(
      1,
    );
    const released = await r.observe(retried.cursor);
    expect(ofType(released.events, 'agent.question')).toEqual([
      expect.objectContaining({
        agent: 'ctx_s',
        externalKey: 'orca:msg:msg_qs',
        question: questionRef('msg_qs'),
        body: 'Q msg_qs?',
      }),
    ]);
    expect(decodeCursor(released.cursor, CursorPayloadSchema).held).toEqual([]);
  });

  it('flags unmanaged: a parent, no aio: title, and a foreign command id', async () => {
    r.observer.close();
    r = await rig({ ownsCommand: (id) => id === 'cmd-own' });
    r.world.tasks.push(
      { id: 't1', title: 'aio:cmd-own child' },
      { id: 't2', title: 'manual helper' },
      { id: 't3', title: 'aio:cmd-foreign work' },
    );
    r.world.workers.push(
      {
        dispatchId: 'ctx_child',
        taskId: 't1',
        parent: { dispatchId: 'ctx_root' },
      },
      { dispatchId: 'ctx_plain', taskId: 't2', provider: 'codex' },
      { dispatchId: 'ctx_foreign', taskId: 't3' },
    );
    const batch = await r.observe(null);
    const unmanaged = ofType(batch.events, 'agent.unmanaged');
    expect(unmanaged.map((e) => e.dispatch).sort()).toEqual([
      'ctx_child',
      'ctx_foreign',
      'ctx_plain',
    ]);
    expect(unmanaged.find((e) => e.dispatch === 'ctx_child')).toMatchObject({
      parentDispatch: 'ctx_root',
    });
    expect(unmanaged.find((e) => e.dispatch === 'ctx_plain')).toMatchObject({
      agentKind: 'codex',
      title: 'manual helper',
    });
    const next = await r.observe(batch.cursor);
    expect(ofType(next.events, 'agent.unmanaged')).toEqual([]);
  });

  it('maps follow-up dispatches to the same AgentRef and ignores superseded rows', async () => {
    spawned(r, 'ctx_a', 'cmd-spawn');
    const first = await r.observe(null);
    // send → new task+dispatch (followUpOf); subject carries aio:.
    r.ledger.pending({ commandId: 'cmd-send', run: RUN, keepOpen: true });
    r.ledger.started('cmd-send', 'ctx_b', 'ctx_a');
    r.world.tasks.push({ id: 'task_b', title: 'aio:cmd-send round 2' });
    r.world.workers[0] = {
      dispatchId: 'ctx_a',
      taskId: 'task_ctx_a',
      owner: null,
      terminalState: null,
      verdict: 'unverifiable',
      workerState: 'succeeded',
    };
    r.world.workers.unshift({
      dispatchId: 'ctx_b',
      taskId: 'task_b',
      origin: 'ctx_a',
      activity: 'working',
    });
    r.world.post({
      id: 'msg_db',
      type: 'worker_done',
      dispatch: 'ctx_b',
      task: 'task_b',
      outcome: 'succeeded',
    });
    const next = await r.observe(first.cursor);
    expect(ofType(next.events, 'agent.done')).toEqual([
      expect.objectContaining({ agent: 'ctx_a', outcome: 'success' }),
    ]);
    expect(
      next.events.filter((e) => 'agent' in e && e.agent !== 'ctx_a'),
    ).toEqual([]);
    expect(ofType(next.events, 'agent.unmanaged')).toEqual([]);
    expect(ofType(next.events, 'agent.exited')).toEqual([]);
  });

  it('rebuilds a lost ledger from worker-list and task-list titles', async () => {
    r.world.tasks.push({ id: 'task_z', title: 'aio:cmd-z build' });
    r.world.workers.push({ dispatchId: 'ctx_z', taskId: 'task_z' });
    const batch = await r.observe(null);
    expect(ofType(batch.events, 'agent.unmanaged')).toEqual([]);
    expect(ofType(batch.events, 'agent.status')[0]).toMatchObject({
      agent: 'ctx_z',
    });
    expect(r.ledger.byCommand('cmd-z')).toMatchObject({
      state: 'started',
      dispatch: 'ctx_z',
    });
  });

  it('derives waiting_input from unanswered questions and clears it after reply', async () => {
    const task = spawned(r, 'ctx_a');
    const first = await r.observe(null);
    r.world.post({ id: 'msg_q', type: 'question', dispatch: 'ctx_a', task });
    const asked = await r.observe(first.cursor);
    expect(ofType(asked.events, 'agent.status')).toEqual([
      expect.objectContaining({
        state: 'waiting_input',
        waitingSince: '2026-11-18T05:50:51.000Z',
      }),
    ]);
    // reply → dispatch mailbox, thread_id = question id (fixture reply.question).
    r.world.mail.push({
      id: 'msg_r',
      type: 'status',
      to: 'dispatch:ctx_a',
      thread: 'msg_q',
      sequence: ++r.world.seq,
      read: true,
    });
    r.clock.now += 10_000;
    const answered = await r.observe(asked.cursor);
    expect(ofType(answered.events, 'agent.status')).toEqual([
      expect.objectContaining({ state: 'working' }),
    ]);
  });

  it('markAnswered clears waiting_input without an inbox read', async () => {
    const task = spawned(r, 'ctx_a');
    const first = await r.observe(null);
    r.world.post({ id: 'msg_q', type: 'question', dispatch: 'ctx_a', task });
    const asked = await r.observe(first.cursor);
    r.observer.markAnswered(questionRef('msg_q'));
    const next = await r.observe(asked.cursor);
    expect(ofType(next.events, 'agent.status')).toEqual([
      expect.objectContaining({ state: 'working' }),
    ]);
  });

  it('follows worker-show agentWait appearing and disappearing', async () => {
    spawned(r, 'ctx_a');
    const first = await r.observe(null);
    r.world.agentWait.set('ctx_a', { kind: 'permission' });
    r.world.workers[0]!.activity = 'blocked';
    const waiting = await r.observe(first.cursor);
    expect(ofType(waiting.events, 'agent.status')).toEqual([
      expect.objectContaining({ state: 'waiting_input' }),
    ]);
    r.world.agentWait.delete('ctx_a');
    r.clock.now += 10_000;
    const resumed = await r.observe(waiting.cursor);
    expect(ofType(resumed.events, 'agent.status')).toEqual([
      expect.objectContaining({ state: 'working' }),
    ]);
  });

  it('emits transcript output once, re-reads from the start on source_changed without duplicates', async () => {
    spawned(r, 'ctx_a');
    r.world.transcripts.set('ctx_a', [
      { id: 'm1', role: 'assistant', text: 'hello' },
      { id: 'm2', role: 'tool', text: 'ok' },
    ]);
    const first = await r.observe(null);
    expect(keys(ofType(first.events, 'agent.output'))).toEqual([
      'orca:tx:ctx_a:m1',
      'orca:tx:ctx_a:m2',
    ]);
    r.world.transcripts
      .get('ctx_a')!
      .push({ id: 'm3', role: 'assistant', text: 'more' });
    r.world.sourceChanged.add('ctx_a');
    r.world.workers[0]!.observedAt = 2;
    r.clock.now += 1_000;
    const next = await r.observe(first.cursor);
    expect(ofType(next.events, 'agent.degraded')).toEqual([
      expect.objectContaining({ reason: 'source_changed' }),
    ]);
    expect(keys(ofType(next.events, 'agent.output'))).toEqual([
      'orca:tx:ctx_a:m3',
    ]);
  });

  it('reports no_transcript_source and transcript_clipped once', async () => {
    spawned(r, 'ctx_a');
    spawned(r, 'ctx_b');
    r.world.noTranscript.add('ctx_a');
    r.world.clipped.add('ctx_b');
    const first = await r.observe(null);
    expect(
      ofType(first.events, 'agent.degraded')
        .map((e) => e.reason)
        .sort(),
    ).toEqual(['no_transcript_source', 'transcript_clipped']);
    for (const w of r.world.workers) w.observedAt = 5;
    const next = await r.observe(first.cursor);
    expect(ofType(next.events, 'agent.degraded')).toEqual([]);
    expect(
      r.world.calls.filter(
        (c) => c[1] === 'worker-read' && c.includes('ctx_a'),
      ),
    ).toHaveLength(1);
  });

  it('detects a usage-limit transcript message without keeping its text', async () => {
    spawned(r, 'ctx_a');
    spawned(r, 'ctx_b');
    r.world.transcripts.set('ctx_a', [
      { id: 'm1', role: 'assistant', text: LIMIT_TEXT },
    ]);
    r.world.transcripts.set('ctx_b', [
      { id: 'm1', role: 'assistant', text: 'Normal progress.' },
    ]);
    const batch = await r.observe(null);
    const limited = ofType(batch.events, 'agent.rate_limited');
    expect(limited).toEqual([
      {
        type: 'agent.rate_limited',
        agent: 'ctx_a',
        evidence: 'transcript',
        resetsAt: new Date(1794990000 * 1000).toISOString(),
        externalKey: 'orca:rate_limited:ctx_a:m1',
        occurredAt: expect.any(String),
      },
    ]);
    expect(JSON.stringify(r.logs)).not.toContain('secret-tail-xyz');
    expect(JSON.stringify(limited)).not.toContain('secret-tail-xyz');
    expect(batch.cursor).not.toContain('secret');
    expect(
      JSON.stringify(decodeCursor(batch.cursor, CursorPayloadSchema)),
    ).not.toContain('secret-tail-xyz');
  });

  it('detects a usage limit from worker-show agentWait evidence', async () => {
    spawned(r, 'ctx_a');
    r.world.agentWait.set('ctx_a', {
      kind: 'rate_limit',
      resetsAt: '2026-11-18T09:00:00Z',
    });
    const batch = await r.observe(null);
    expect(ofType(batch.events, 'agent.rate_limited')).toEqual([
      expect.objectContaining({
        evidence: 'worker-show',
        resetsAt: '2026-11-18T09:00:00.000Z',
      }),
    ]);
    expect(ofType(batch.events, 'agent.status')).toEqual([
      expect.objectContaining({ state: 'working' }),
    ]);
  });

  it('turns schema drift into one runtime.contract_mismatch without values', async () => {
    spawned(r, 'ctx_a');
    const respond = r.world.respond.bind(r.world);
    r.world.respond = async (args) =>
      args[1] === 'worker-list'
        ? ok({ workers: [{ dispatchId: 'secret-value', taskId: 7 }] })
        : respond(args);
    const batch = await r.observe(null);
    const mismatch = ofType(batch.events, 'runtime.contract_mismatch');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.command).toBe('orchestration worker-list');
    expect(JSON.stringify(mismatch)).not.toContain('secret-value');
  });
});

describe('OrcaObserver: CLI budget (SPEC §6.4)', () => {
  it('stays near 80 calls per minute with 10 active workers', async () => {
    const r = await rig();
    for (let i = 0; i < 10; i++) spawned(r, `ctx_${i}`);
    let cursor: RuntimeCursor | null = null;
    // Observation loop ticks every second for one minute; activity changes every 15 s.
    const start = r.clock.now;
    const before = r.world.calls.length;
    while (r.clock.now - start < 60_000) {
      const tick = r.clock.now - start;
      if (tick % 15_000 < 1_000)
        for (const w of r.world.workers) w.observedAt = tick;
      if (tick > 0 && tick % 30_000 < 1_000) r.world.timeout();
      const result = await r.observer.observe(session, cursor);
      cursor = result.cursor;
      r.clock.now += 1_000;
    }
    const calls = r.world.calls.length - before;
    r.observer.close();
    expect(r.world.count('orchestration worker-list')).toBeLessThanOrEqual(31);
    expect(calls).toBeLessThanOrEqual(90);
  });
});
