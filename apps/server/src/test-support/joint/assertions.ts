/**
 * M5-T7 restart assertions (M5_PLAN §2.3.4 #1–10 and #12–17; #11 is T17's
 * UI check). Pure functions over the workflow event log plus the harness's
 * observations (Orca reads, GitHub or stand-in facts, files, sessions).
 * Missing observations make a row (or the part of it) `n/a`, never a pass.
 * Details carry counts, ids and booleans only — never bodies.
 */
import {
  duplicatedFacts,
  repeatedSends,
  type Json,
} from '../orca/t17/checks.js';
import type { RestartRecord } from './restart.js';

export type AssertionStatus = 'pass' | 'fail' | 'n/a';

export interface AssertionResult {
  id: number;
  name: string;
  status: AssertionStatus;
  detail: Record<string, number | boolean | string | null>;
}

/** What the harness observed around the one restart. */
export interface RestartEvidence {
  /** The full workflow log, seq-ordered. */
  events: Json[];
  restart?: RestartRecord;
  /** Highest seq the harness saw before the kill. */
  killSeq?: number;
  /** `orca check` process groups of the shim (counts, M2 hybrid inventory). */
  orphans?: { before: number; aliveAfterRestart: number };
  /** GitHub facts (GA) or the stand-in's equivalent (T11b). */
  scm?: {
    /** Integration-branch first-parent commits after its base, oldest first. */
    integrationFirstParents?: string[];
    /** `ai-office:cmd=` commandId → objects carrying it in the namespace. */
    markerCounts?: Record<string, number>;
    /** `duplicate-object` anomalies were converged and reported. */
    duplicatesConverged?: boolean;
  };
  orca?: {
    /** `inbox --terminal run:<run>` message ids and sequences. */
    inbox?: { id: string; sequence: number }[];
    /** Inbox ids recorded as non-event classifications. */
    classified?: string[];
    runtimeCursorLastSeq?: number;
    shimHandles?: { before: string[]; after: string[] };
    runs?: number;
    /** Our worktree names (by name and marker); duplicates fail #12. */
    worktreeNames?: string[];
    /** `consumer_generation` changes, and how many our reclaims explain. */
    consumerGenerationChanges?: number;
    reclaims?: number;
    /** Dispatch ids of our agents. */
    dispatches?: string[];
  };
  files?: {
    controlTokenRotated?: boolean;
    oldControlTokenStatus?: number;
    caffeinateForNewPid?: boolean;
  };
  session?: { oldCookieStatus?: number; openSessionStatus?: number };
  /** Domain seqs the harness SSE received (with Last-Event-ID reconnects). */
  sse?: { seqs: number[]; reconnects: number };
  /** Lock-held samples across the run. */
  locks?: { github: boolean[]; orca: boolean[] };
}

type Detail = AssertionResult['detail'];
const verdict = (
  id: number,
  name: string,
  parts: (boolean | undefined)[],
  detail: Detail,
): AssertionResult => ({
  id,
  name,
  // Any known failure fails; all unknown is n/a; otherwise pass.
  status: parts.includes(false)
    ? 'fail'
    : parts.every((p) => p === undefined)
      ? 'n/a'
      : 'pass',
  detail,
});

const of = (events: Json[], type: string) =>
  events.filter((e) => e.type === type);
const seqOf = (e: Json) => Number(e.seq);
const kindIs = (kind: string) => (e: Json) => e.payload?.kind === kind;

function terminals(events: Json[]) {
  const out = new Map<string, Json[]>();
  for (const e of events)
    if (e.type === 'command.succeeded' || e.type === 'command.failed') {
      const id = String(e.payload.commandId);
      out.set(id, [...(out.get(id) ?? []), e]);
    }
  return out;
}

/** Commands issued at or before the kill with no result at that point. */
export function inFlightAtKill(events: Json[], killSeq: number): string[] {
  const settled = new Set(
    events
      .filter(
        (e) =>
          seqOf(e) <= killSeq &&
          (e.type === 'command.succeeded' || e.type === 'command.failed'),
      )
      .map((e) => String(e.payload.commandId)),
  );
  return of(events, 'command.issued')
    .filter((e) => seqOf(e) <= killSeq)
    .map((e) => String(e.payload.commandId))
    .filter((id) => !settled.has(id));
}

/** #1 single-instance lock taken over; stray `orca check` groups cleared. */
export function a1SingleInstance(x: RestartEvidence): AssertionResult {
  const r = x.restart;
  return verdict(
    1,
    'single-instance lock moved to the new process',
    [
      r ? r.runtimePidAfter === r.newPid && r.newPid !== r.oldPid : undefined,
      r ? !r.oldPidAliveAfter : undefined,
      x.orphans ? x.orphans.aliveAfterRestart === 0 : undefined,
    ],
    {
      newPidOwnsRuntime: r ? r.runtimePidAfter === r.newPid : null,
      oldPidAlive: r?.oldPidAliveAfter ?? null,
      checkGroupsBefore: x.orphans?.before ?? null,
      checkGroupsAlive: x.orphans?.aliveAfterRestart ?? null,
    },
  );
}

/** #2 every in-flight command: exactly one result plus `reconciled{found|redone}`. */
export function a2InFlightCommands(x: RestartEvidence): AssertionResult {
  const gaveUp = of(x.events, 'command.reconciled').filter(
    (e) => e.payload.outcome === 'gave_up',
  ).length;
  if (x.killSeq === undefined)
    return verdict(2, 'in-flight commands settle once', [gaveUp === 0], {
      inFlight: null,
      gaveUp,
    });
  const pending = inFlightAtKill(x.events, x.killSeq);
  const results = terminals(x.events);
  const reconciled = new Map(
    of(x.events, 'command.reconciled').map((e) => [
      String(e.payload.commandId),
      String(e.payload.outcome),
    ]),
  );
  let badResults = 0,
    unreconciled = 0,
    foundWithoutSuccess = 0;
  for (const id of pending) {
    const done = results.get(id) ?? [];
    if (done.length !== 1) badResults++;
    const outcome = reconciled.get(id);
    if (outcome !== 'found' && outcome !== 'redone') unreconciled++;
    if (outcome === 'found' && done[0]?.type !== 'command.succeeded')
      foundWithoutSuccess++;
  }
  return verdict(
    2,
    'in-flight commands settle once',
    [
      badResults === 0,
      unreconciled === 0,
      foundWithoutSuccess === 0,
      gaveUp === 0,
    ],
    {
      inFlight: pending.length,
      badResults,
      unreconciled,
      foundWithoutSuccess,
      gaveUp,
    },
  );
}

/** #3 one merge commit per worker PR; first-parent order = `workitem.merged` order. */
export function a3NoDuplicateMerge(x: RestartEvidence): AssertionResult {
  const merged = of(x.events, 'workitem.merged');
  const perItem = new Map<string, Set<string>>();
  for (const e of merged)
    perItem.set(
      e.payload.itemKey,
      (perItem.get(e.payload.itemKey) ?? new Set()).add(
        e.payload.mergeCommitSha,
      ),
    );
  const mergeSuccesses = new Map<number, number>();
  const issued = new Map(
    of(x.events, 'command.issued')
      .filter(kindIs('scm.mergePR'))
      .map((e) => [
        String(e.payload.commandId),
        Number(e.payload.args?.pr?.number),
      ]),
  );
  for (const e of of(x.events, 'command.succeeded').filter(
    kindIs('scm.mergePR'),
  )) {
    const pr = issued.get(String(e.payload.commandId));
    if (pr !== undefined)
      mergeSuccesses.set(pr, (mergeSuccesses.get(pr) ?? 0) + 1);
  }
  const shas = merged.map((e) => String(e.payload.mergeCommitSha));
  const firstParents = x.scm?.integrationFirstParents;
  return verdict(
    3,
    'no duplicate merge',
    [
      [...perItem.values()].every((s) => s.size === 1),
      [...mergeSuccesses.values()].every((n) => n === 1),
      firstParents === undefined
        ? undefined
        : firstParents.length === shas.length &&
          firstParents.every((sha, i) => sha === shas[i]),
    ],
    {
      mergedItems: perItem.size,
      itemsWithSeveralMerges: [...perItem.values()].filter((s) => s.size > 1)
        .length,
      prsMergedTwice: [...mergeSuccesses.values()].filter((n) => n > 1).length,
      firstParents: firstParents?.length ?? null,
      firstParentsMatch:
        firstParents === undefined
          ? null
          : firstParents.length === shas.length &&
            firstParents.every((sha, i) => sha === shas[i]),
    },
  );
}

const CREATE_KINDS = ['scm.createIssue', 'scm.openPR', 'scm.comment'];

/** #4 ≤ 1 object per commandId; `duplicate-object` anomalies 0 (or converged). */
export function a4NoDuplicateCreate(x: RestartEvidence): AssertionResult {
  const successes = new Map<string, number>();
  for (const e of of(x.events, 'command.succeeded'))
    if (CREATE_KINDS.includes(e.payload.kind))
      successes.set(
        e.payload.commandId,
        (successes.get(e.payload.commandId) ?? 0) + 1,
      );
  const duplicates = of(x.events, 'anomaly.detected').filter(
    (e) => e.payload.kind === 'duplicate-object',
  ).length;
  const markers = x.scm?.markerCounts;
  const overMarked = markers
    ? Object.values(markers).filter((n) => n > 1).length
    : undefined;
  return verdict(
    4,
    'no duplicate creation',
    [
      [...successes.values()].every((n) => n === 1),
      overMarked === undefined ? undefined : overMarked === 0,
      duplicates === 0 || x.scm?.duplicatesConverged === true,
    ],
    {
      creates: successes.size,
      markerScanned: markers ? Object.keys(markers).length : null,
      commandIdsWithSeveralObjects: overMarked ?? null,
      duplicateObjectAnomalies: duplicates,
    },
  );
}

/** #5 no repeated spawn or send; our dispatches never `agent.unmanaged`. */
export function a5NoDuplicateSpawnSend(x: RestartEvidence): AssertionResult {
  const spawns = new Map<string, number>();
  for (const e of of(x.events, 'command.issued').filter(
    kindIs('runtime.spawnAgent'),
  )) {
    const id = String(e.attemptId ?? e.payload.args?.attemptId ?? '?');
    spawns.set(id, (spawns.get(id) ?? 0) + 1);
  }
  const ours = new Set(x.orca?.dispatches ?? []);
  const unmanagedOurs = of(x.events, 'agent.unmanaged').filter((e) =>
    ours.has(String(e.payload.dispatch)),
  ).length;
  const repeated = repeatedSends(x.events).length;
  return verdict(
    5,
    'no duplicate spawn or send',
    [
      repeated === 0,
      [...spawns.values()].every((n) => n === 1),
      x.orca?.dispatches === undefined ? undefined : unmanagedOurs === 0,
    ],
    {
      repeatedSends: repeated,
      attemptsSpawnedTwice: [...spawns.values()].filter((n) => n > 1).length,
      unmanagedOurDispatches: x.orca?.dispatches ? unmanagedOurs : null,
    },
  );
}

/** #6 every inbox message → exactly one `orca:msg:<id>` event or classification. */
export function a6MailboxExactlyOnce(x: RestartEvidence): AssertionResult {
  const keys = new Map<string, number>();
  for (const e of x.events) {
    const key = typeof e.externalKey === 'string' ? e.externalKey : undefined;
    if (key?.startsWith('orca:msg:')) {
      const id = key.slice('orca:msg:'.length);
      keys.set(id, (keys.get(id) ?? 0) + 1);
    }
  }
  const classified = new Set(x.orca?.classified ?? []);
  const inbox = x.orca?.inbox;
  let unmatched = 0,
    doubled = 0;
  for (const m of inbox ?? []) {
    const n = (keys.get(m.id) ?? 0) + (classified.has(m.id) ? 1 : 0);
    if (n === 0) unmatched++;
    if (n > 1) doubled++;
  }
  const dupFacts = duplicatedFacts(x.events).length;
  return verdict(
    6,
    'mailbox exactly-once',
    [
      inbox === undefined ? undefined : unmatched === 0 && doubled === 0,
      dupFacts === 0,
    ],
    {
      inbox: inbox?.length ?? null,
      unmatched: inbox ? unmatched : null,
      doubled: inbox ? doubled : null,
      duplicatedFacts: dupFacts,
    },
  );
}

/** #7 runtime cursor caught up with the inbox; no repeated `gh:*` externalKey. */
export function a7IngestCursor(x: RestartEvidence): AssertionResult {
  const gh = new Map<string, number>();
  for (const e of x.events)
    if (typeof e.externalKey === 'string' && e.externalKey.startsWith('gh:'))
      gh.set(e.externalKey, (gh.get(e.externalKey) ?? 0) + 1);
  const maxInbox = x.orca?.inbox?.length
    ? Math.max(...x.orca.inbox.map((m) => m.sequence))
    : undefined;
  const cursor = x.orca?.runtimeCursorLastSeq;
  return verdict(
    7,
    'ingest cursors',
    [
      cursor === undefined || maxInbox === undefined
        ? undefined
        : cursor >= maxInbox,
      [...gh.values()].every((n) => n === 1),
    ],
    {
      runtimeCursorLastSeq: cursor ?? null,
      inboxMaxSequence: maxInbox ?? null,
      repeatedGhKeys: [...gh.values()].filter((n) => n > 1).length,
    },
  );
}

/** #8 submissions during downtime land once; an in-flight merge-request merges once. */
export function a8Submissions(x: RestartEvidence): AssertionResult {
  const accepted = of(x.events, 'submission.accepted');
  const ids = new Map<string, number>();
  for (const e of accepted)
    ids.set(e.payload.submissionId, (ids.get(e.payload.submissionId) ?? 0) + 1);
  // One accepted merge-request per (attempt, PR, head): a resend never doubles.
  const mergeRequests = new Map<string, number>();
  for (const e of accepted.filter((e) => e.payload.kind === 'merge-request')) {
    const s = (e.payload.submission?.payload ?? {}) as Json;
    const key = `${e.payload.attemptId}|${s.pr ?? '?'}|${s.expectedHeadSha ?? '?'}`;
    mergeRequests.set(key, (mergeRequests.get(key) ?? 0) + 1);
  }
  const merge = a3NoDuplicateMerge(x);
  return verdict(
    8,
    'submissions during downtime land once',
    [
      [...ids.values()].every((n) => n === 1),
      [...mergeRequests.values()].every((n) => n === 1),
      merge.status === 'n/a' ? undefined : merge.status === 'pass',
    ],
    {
      accepted: accepted.length,
      repeatedSubmissionIds: [...ids.values()].filter((n) => n > 1).length,
      repeatedMergeRequests: [...mergeRequests.values()].filter((n) => n > 1)
        .length,
      noDuplicateMerge: merge.status === 'pass',
    },
  );
}

const TIMEOUT_REASONS = new Set([
  'round-timeout',
  'stage-timeout',
  'item-timeout',
  'question-timeout',
  'review-timeout',
  'spawn-stall',
]);

/**
 * #9 no timeout, nudge or `spawn-stall` gate caused by the downtime (from the
 * kill until the restart settled), and no question-timeout for the held
 * escalation (`n/a` for the waiter part without a held question).
 */
export function a9Timers(
  x: RestartEvidence,
  options: { settleSeq?: number; heldQuestionAttempt?: string } = {},
): AssertionResult {
  if (x.killSeq === undefined)
    return verdict(9, 'no timer fired by the downtime', [undefined], {
      window: null,
    });
  const from = x.killSeq;
  const to = options.settleSeq ?? Number.MAX_SAFE_INTEGER;
  const window = x.events.filter((e) => seqOf(e) > from && seqOf(e) <= to);
  const nudges = window.filter(
    (e) => e.type === 'message.nudge' && TIMEOUT_REASONS.has(e.payload.reason),
  ).length;
  const stallGates = window.filter(
    (e) =>
      e.type === 'gate.opened' && e.payload.exceptionKind === 'spawn-stall',
  ).length;
  const waiter = options.heldQuestionAttempt;
  const waiterTimeouts =
    waiter === undefined
      ? undefined
      : of(x.events, 'message.nudge').filter(
          (e) =>
            e.payload.attemptId === waiter &&
            e.payload.reason === 'question-timeout',
        ).length;
  return verdict(
    9,
    'no timer fired by the downtime',
    [
      nudges === 0,
      stallGates === 0,
      waiterTimeouts === undefined ? undefined : waiterTimeouts === 0,
    ],
    {
      nudges,
      spawnStallGates: stallGates,
      waiterQuestionTimeouts: waiterTimeouts ?? 'n/a',
    },
  );
}

/** #10 the flow reached the final-PR gate; the restart opened no anomaly gate. */
export function a10ReachedFinalGate(x: RestartEvidence): AssertionResult {
  const opened = of(x.events, 'gate.opened');
  const finalGate = opened.some((e) => e.payload.stageKind === 'final-pr');
  const anomalyGates = opened.filter(
    (e) =>
      e.payload.exceptionKind === 'anomaly' &&
      (x.killSeq === undefined || seqOf(e) > x.killSeq),
  ).length;
  return verdict(
    10,
    'flow reached the final-PR gate',
    [finalGate, anomalyGates === 0],
    { finalGate, anomalyGatesAfterKill: anomalyGates },
  );
}

/** #12 Orca: shim reused, one run, one openSession, no hijack, no duplicate worktree. */
export function a12Orca(x: RestartEvidence): AssertionResult {
  const opens = of(x.events, 'command.issued').filter(
    kindIs('runtime.openSession'),
  ).length;
  const hijacked = of(x.events, 'runtime.identity_hijacked').length;
  const shims = x.orca?.shimHandles;
  const names = x.orca?.worktreeNames;
  const generation = x.orca?.consumerGenerationChanges;
  return verdict(
    12,
    'Orca side unchanged by the restart',
    [
      shims === undefined
        ? undefined
        : shims.after.length === shims.before.length &&
          shims.after.every((s) => shims.before.includes(s)),
      x.orca?.runs === undefined ? undefined : x.orca.runs === 1,
      opens === 1,
      hijacked === 0,
      generation === undefined
        ? undefined
        : generation <= (x.orca?.reclaims ?? 0),
      names === undefined ? undefined : new Set(names).size === names.length,
    ],
    {
      openSessions: opens,
      identityHijacked: hijacked,
      newShims: shims
        ? shims.after.filter((s) => !shims.before.includes(s)).length
        : null,
      runs: x.orca?.runs ?? null,
      consumerGenerationChanges: generation ?? null,
      duplicateWorktrees: names ? names.length - new Set(names).size : null,
    },
  );
}

/** #13 usage externalKeys unique; per-attempt cumulative totals never drop. */
export function a13Usage(x: RestartEvidence): AssertionResult {
  const keys = new Map<string, number>();
  let negative = 0;
  const usage = of(x.events, 'usage.tokens');
  for (const e of usage) {
    if (typeof e.externalKey === 'string')
      keys.set(e.externalKey, (keys.get(e.externalKey) ?? 0) + 1);
    // Deltas: a negative field would make the cumulative value drop.
    for (const k of ['inputUncached', 'output', 'cacheRead', 'cacheWrite'])
      if (Number(e.payload[k] ?? 0) < 0) negative++;
  }
  const repeated = [...keys.values()].filter((n) => n > 1).length;
  return verdict(
    13,
    'usage not double-counted',
    [usage.length > 0 ? repeated === 0 && negative === 0 : undefined],
    {
      usageEvents: usage.length,
      repeatedKeys: repeated,
      negativeDeltas: negative,
    },
  );
}

/** #14 runtime.json new pid; control token rotated (old → 401); caffeinate for the new pid. */
export function a14Files(x: RestartEvidence): AssertionResult {
  const r = x.restart;
  const f = x.files ?? {};
  return verdict(
    14,
    'single instance and files',
    [
      r ? r.runtimePidAfter === r.newPid : undefined,
      f.controlTokenRotated,
      f.oldControlTokenStatus === undefined
        ? undefined
        : f.oldControlTokenStatus === 401,
      f.caffeinateForNewPid,
    ],
    {
      runtimePidIsNew: r ? r.runtimePidAfter === r.newPid : null,
      controlTokenRotated: f.controlTokenRotated ?? null,
      oldControlTokenStatus: f.oldControlTokenStatus ?? null,
      caffeinateForNewPid: f.caffeinateForNewPid ?? null,
    },
  );
}

/**
 * #15 old cookie still valid; the SSE (Last-Event-ID) saw every seq of the
 * workflow from its first frame on exactly once; `ai-office open` session valid.
 */
export function a15SseAndSession(x: RestartEvidence): AssertionResult {
  const s = x.session ?? {};
  const seqs = x.sse?.seqs;
  let gaps: number | undefined, dups: number | undefined;
  if (seqs?.length) {
    const first = Math.min(...seqs);
    const expected = x.events.map(seqOf).filter((n) => n >= first);
    const got = new Map<number, number>();
    for (const n of seqs) got.set(n, (got.get(n) ?? 0) + 1);
    gaps = expected.filter((n) => !got.has(n)).length;
    dups = [...got.values()].filter((n) => n > 1).length;
  }
  return verdict(
    15,
    'SSE and sessions survive the restart',
    [
      s.oldCookieStatus === undefined ? undefined : s.oldCookieStatus === 200,
      gaps === undefined ? undefined : gaps === 0 && dups === 0,
      x.sse === undefined ? undefined : x.sse.reconnects >= 1,
      s.openSessionStatus === undefined
        ? undefined
        : s.openSessionStatus === 200,
    ],
    {
      oldCookieStatus: s.oldCookieStatus ?? null,
      openSessionStatus: s.openSessionStatus ?? null,
      sseFrames: seqs?.length ?? null,
      sseGaps: gaps ?? null,
      sseDuplicates: dups ?? null,
      sseReconnects: x.sse?.reconnects ?? null,
    },
  );
}

/** #16 both live locks held for the whole run (the kill does not touch them). */
export function a16Locks(x: RestartEvidence): AssertionResult {
  const l = x.locks;
  return verdict(
    16,
    'live locks held throughout',
    [
      l && l.github.length ? l.github.every(Boolean) : undefined,
      l && l.orca.length ? l.orca.every(Boolean) : undefined,
    ],
    {
      githubSamples: l?.github.length ?? null,
      orcaSamples: l?.orca.length ?? null,
    },
  );
}

/**
 * #17 (revised, coordinator ruling): the submit in flight across the kill.
 * Retries during the downtime fail at TCP level and the backend writes no
 * request log, so the resend itself is not counted. Instead, on K:
 * (a') the integrator's merge-request for the K PR is accepted exactly once
 * in the whole log, before the kill, and that PR's merge outcome lands after
 * the kill — `command.reconciled{found|redone}` plus exactly one
 * `command.succeeded{scm.mergePR}`, or `workitem.merged` for its item — with
 * no second merge commit for it on the integration first-parent history;
 * (b) no submission id is accepted twice. (a') is `n/a` on K′.
 * "After the kill" is by seq: the startup reconcile runs before the new
 * process writes runtime.json, so its events can precede the ready time.
 */
export function a17InFlightSubmission(x: RestartEvidence): AssertionResult {
  const ids = new Map<string, number>();
  for (const e of of(x.events, 'submission.accepted'))
    ids.set(e.payload.submissionId, (ids.get(e.payload.submissionId) ?? 0) + 1);
  const repeatedIds = [...ids.values()].filter((n) => n > 1).length;
  // (b) needs at least one acceptance to say anything.
  const uniqueIds = ids.size ? repeatedIds === 0 : undefined;
  const r = x.restart;
  if (!r || r.trigger !== 'K')
    return verdict(
      17,
      'in-flight submission recorded once (revised)',
      [uniqueIds],
      {
        trigger: r?.trigger ?? null,
        inFlightSubmission: 'n/a',
        repeatedSubmissionIds: repeatedIds,
      },
    );
  const kill = x.killSeq ?? r.triggerSeq;
  const issued = of(x.events, 'command.issued').find(
    (e) => seqOf(e) === r.triggerSeq,
  );
  const commandId = String(issued?.payload.commandId);
  const pr = Number(issued?.payload.args?.pr?.number);
  const accepted = of(x.events, 'submission.accepted').filter(
    (e) =>
      e.payload.kind === 'merge-request' &&
      Number(e.payload.submission?.payload?.pr) === pr,
  );
  const acceptedBeforeKill = accepted.filter((e) => seqOf(e) <= kill).length;
  const after = x.events.filter((e) => seqOf(e) > kill);
  const reconciled = after.some(
    (e) =>
      e.type === 'command.reconciled' &&
      e.payload.commandId === commandId &&
      ['found', 'redone'].includes(e.payload.outcome),
  );
  const succeeded = of(x.events, 'command.succeeded').filter(
    (e) => e.payload.commandId === commandId,
  );
  const succeededAfter = succeeded.filter((e) => seqOf(e) > kill).length;
  const item = of(x.events, 'workitem.merge_queued').find(
    (e) => Number(e.payload.pr) === pr,
  )?.payload.itemKey as string | undefined;
  const mergedAfter = after.filter(
    (e) => e.type === 'workitem.merged' && e.payload.itemKey === item,
  );
  const outcome =
    (reconciled && succeeded.length === 1 && succeededAfter === 1) ||
    (item !== undefined && mergedAfter.length >= 1);
  const shas = new Set(
    of(x.events, 'workitem.merged')
      .filter((e) => e.payload.itemKey === item)
      .map((e) => String(e.payload.mergeCommitSha)),
  );
  const firstParents = x.scm?.integrationFirstParents;
  const singleMergeCommit =
    firstParents === undefined || shas.size !== 1
      ? undefined
      : firstParents.filter((sha) => shas.has(sha)).length === 1;
  return verdict(
    17,
    'in-flight submission recorded once (revised)',
    [
      accepted.length === 1 && acceptedBeforeKill === 1,
      outcome,
      shas.size <= 1,
      singleMergeCommit,
      uniqueIds,
    ],
    {
      pr: Number.isSafeInteger(pr) ? pr : null,
      acceptedForPr: accepted.length,
      acceptedBeforeKill,
      reconciledAfterKill: reconciled,
      mergeSucceededAfterKill: succeededAfter,
      itemMergedAfterKill: mergedAfter.length,
      mergeCommitsForPr: shas.size,
      singleFirstParentMerge: singleMergeCommit ?? null,
      repeatedSubmissionIds: repeatedIds,
    },
  );
}

/** Every T7 row, in §2.3.4 order (#11 belongs to T17). */
export function restartAssertions(
  x: RestartEvidence,
  options: Parameters<typeof a9Timers>[1] = {},
): AssertionResult[] {
  return [
    a1SingleInstance(x),
    a2InFlightCommands(x),
    a3NoDuplicateMerge(x),
    a4NoDuplicateCreate(x),
    a5NoDuplicateSpawnSend(x),
    a6MailboxExactlyOnce(x),
    a7IngestCursor(x),
    a8Submissions(x),
    a9Timers(x, options),
    a10ReachedFinalGate(x),
    a12Orca(x),
    a13Usage(x),
    a14Files(x),
    a15SseAndSession(x),
    a16Locks(x),
    a17InFlightSubmission(x),
  ];
}
