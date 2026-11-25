import { CONTROL_TOKEN_PREFIX } from '@ai-office/contracts/agent-submission';
import { textPlaceholder } from '../joint/export/index.js';
import type { AcceptanceFacts } from './facts.js';

export { parseFacts } from './facts.js';
export type { AcceptanceFacts } from './facts.js';

/*
 * SPEC §24 acceptance checker (M5_PLAN §5 T10, §9.1). Pure: events plus an
 * optional facts snapshot in, one verdict per §9.1 row out. It judges by
 * structure only — types, seq, numbers, SHAs, enum values and the equality of
 * ids — so a B4-masked export (deterministic placeholders) gets the same
 * verdicts as the raw log. Links between events use only fields the export
 * allowlist keeps on both sides (e.g. merges join commands by mergeCommitSha,
 * never by `workitem.merged.commandId`).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped exported JSON
type Json = Record<string, any>;
interface Ev {
  seq: number;
  type: string;
  source?: string;
  occurredAt?: string;
  recordedAt?: string;
  externalKey?: string;
  id?: string;
  payload: Json;
}

export type Verdict = 'pass' | 'fail' | 'na';
export interface AcceptanceRow {
  id: string;
  section: 'non-functional' | 'v0.1' | 'extra';
  title: string;
  verdict: Verdict;
  /** Pointers into the log (`#<seq> <type> …`) or to the facts and external evidence. */
  evidence: string[];
}
export interface AcceptanceReport {
  rows: AcceptanceRow[];
  summary: Record<Verdict, number>;
}

/**
 * Facts come from the raw run, but the B4 export placeholders allowlisted ids
 * that fail its leak check (compound ids such as gate ids trip the entropy
 * heuristic), so a fact id also matches its deterministic placeholder.
 */
const matchesFact = (logged: unknown, fact: string) =>
  logged === fact || logged === textPlaceholder(fact);

const ptr = (e: Ev, detail?: string | number) =>
  `#${e.seq} ${e.type}${detail === undefined ? '' : ' ' + detail}`;

function row(
  id: string,
  section: AcceptanceRow['section'],
  title: string,
  verdict: Verdict,
  evidence: string[],
): AcceptanceRow {
  return { id, section, title, verdict, evidence };
}
/** `problems` decide the verdict; `context` is evidence either way. */
const judged = (
  id: string,
  section: AcceptanceRow['section'],
  title: string,
  problems: string[],
  context: string[],
) =>
  row(
    id,
    section,
    title,
    problems.length === 0 ? 'pass' : 'fail',
    problems.length === 0
      ? context
      : [...problems.map((p) => 'FAIL ' + p), ...context],
  );
const external = (
  id: string,
  section: AcceptanceRow['section'],
  title: string,
  where: string,
) => row(id, section, title, 'na', [where]);

function duplicates<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const dup = new Set<T>();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup];
}

/** Accepts a bare event array or the `{exportedAt, …, events}` export envelope. */
export function eventsOf(input: unknown): Json[] {
  const events = Array.isArray(input) ? input : (input as Json | null)?.events;
  if (!Array.isArray(events))
    throw new Error('Expected an event array or an export with "events"');
  return events as Json[];
}

class Log {
  readonly events: Ev[];
  constructor(raw: readonly Json[]) {
    this.events = raw.map((e, index) => {
      if (
        typeof e !== 'object' ||
        e === null ||
        !Number.isInteger(e.seq) ||
        typeof e.type !== 'string'
      )
        throw new Error(`Event ${index} has no integer seq or string type`);
      return { ...e, payload: (e.payload ?? {}) as Json } as Ev;
    });
  }
  of(type: string): Ev[] {
    return this.events.filter((e) => e.type === type);
  }
  stageGates(): Ev[] {
    return this.of('gate.opened').filter((e) => e.payload.kind === 'stage');
  }
  workerPrs(): Set<number> {
    const prs = new Set<number>();
    for (const type of [
      'workitem.merge_queued',
      'workitem.merged',
      'workitem.rework_requested',
      'workitem.status',
    ])
      for (const e of this.of(type))
        if (typeof e.payload.pr === 'number') prs.add(e.payload.pr);
    return prs;
  }
  itemOfPr(pr: number): string | undefined {
    return this.of('workitem.merge_queued').find((e) => e.payload.pr === pr)
      ?.payload.itemKey as string | undefined;
  }
  mergePrCommands(): { issued: Ev; pr: number }[] {
    return this.of('command.issued')
      .filter((e) => e.payload.kind === 'scm.mergePR')
      .map((issued) => ({ issued, pr: issued.payload.args?.pr?.number }));
  }
}

// --- non-functional ---------------------------------------------------------

/** recordedAt − occurredAt of the selected events, ascending. */
function lags(log: Log, pick: (e: Ev) => boolean) {
  return log.events
    .filter(pick)
    .map((e) => ({
      e,
      lag: Date.parse(e.recordedAt ?? '') - Date.parse(e.occurredAt ?? ''),
    }))
    .filter((x) => Number.isFinite(x.lag))
    .sort((a, b) => a.lag - b.lag);
}
const quantile = (sorted: { lag: number }[], q: number) =>
  sorted[Math.ceil(sorted.length * q) - 1]!.lag;
const describeLags = (label: string, sorted: { e: Ev; lag: number }[]) =>
  sorted.length === 0
    ? `${label}: none`
    : `${label}: p50 ${quantile(sorted, 0.5)} ms, p95 ${quantile(sorted, 0.95)} ms, worst ${ptr(sorted.at(-1)!.e)} ${sorted.at(-1)!.lag} ms over ${sorted.length}`;
function p95Row(
  id: string,
  title: string,
  sorted: { e: Ev; lag: number }[],
  limitMs: number,
  what: string,
  context: string[],
): AcceptanceRow {
  if (sorted.length === 0)
    return row(id, 'non-functional', title, 'na', [`no ${what}`, ...context]);
  const p95 = quantile(sorted, 0.95);
  return judged(
    id,
    'non-functional',
    title,
    p95 < limitMs ? [] : [`backend p95 ${p95} ms ≥ ${limitMs} ms`],
    [
      describeLags(`backend recordedAt − occurredAt (${what})`, sorted),
      ...context,
    ],
  );
}

const runtime = (e: Ev) => e.source === 'runtime';
/**
 * SPEC §24 即時性 (realtime): "Orca 狀態變化到畫面更新 p95 < 3 秒（狀態由 2 秒
 * worker-list 提供、訊息由 long-poll 提供）": state from worker-list and
 * long-poll mail only (FX-STATUS-LATENCY). Transcript-derived events have
 * their own row; usage and PR status are reported, not judged.
 */
function latency(log: Log): AcceptanceRow {
  return p95Row(
    'nf.latency',
    'Realtime: state and messages p95 < 3 s (§24)',
    lags(
      log,
      (e) =>
        runtime(e) &&
        (e.type === 'seat.status' || e.type.startsWith('message.')),
    ),
    3000,
    'runtime seat.status / message.* events',
    [
      describeLags(
        'info: usage.tokens',
        lags(log, (e) => e.type === 'usage.tokens'),
      ),
      describeLags(
        'info: pr.status',
        lags(log, (e) => e.type === 'pr.status'),
      ),
      'frontend apply delay: T17',
    ],
  );
}
/** Transcript-derived activity and turns (FX-STATUS-LATENCY): p95 < 15 s. */
function activityLatency(log: Log): AcceptanceRow {
  return p95Row(
    'nf.activity-latency',
    'Activity: transcript-derived seat.activity / usage.turns p95 < 15 s',
    lags(
      log,
      (e) =>
        runtime(e) && (e.type === 'seat.activity' || e.type === 'usage.turns'),
    ),
    15_000,
    'runtime seat.activity / usage.turns events',
    [],
  );
}

function reliability(log: Log, facts: AcceptanceFacts): AcceptanceRow {
  const problems: string[] = [];
  const spawned = log.of('seat.spawned');
  for (const id of duplicates(spawned.map((e) => e.payload.attemptId)))
    problems.push(
      `attempt spawned twice: ${ptr(spawned.find((e) => e.payload.attemptId === id)!)}`,
    );
  const dispatched = log.of('workitem.dispatched');
  for (const id of duplicates(dispatched.map((e) => e.payload.attemptId)))
    problems.push(
      `attempt dispatched twice: ${ptr(dispatched.find((e) => e.payload.attemptId === id)!)}`,
    );
  const objects = log
    .of('artifact.created')
    .filter((e) => e.payload.kind === 'issue' || e.payload.kind === 'pr');
  for (const n of duplicates(objects.map((e) => e.payload.number)))
    problems.push(`Issue/PR #${n} recorded twice`);
  for (const e of log.of('anomaly.detected'))
    if (e.payload.kind === 'duplicate-object')
      problems.push(ptr(e, 'duplicate-object'));
  // §2.3.4 #2: every issued command ends exactly once, and reconcile never gives up.
  const terminals = new Map<string, number>();
  for (const e of [...log.of('command.succeeded'), ...log.of('command.failed')])
    terminals.set(
      e.payload.commandId,
      (terminals.get(e.payload.commandId) ?? 0) + 1,
    );
  const issued = log.of('command.issued');
  for (const e of issued)
    if (!terminals.has(e.payload.commandId))
      problems.push(`no result: ${ptr(e, e.payload.kind)}`);
  for (const e of log.of('command.reconciled'))
    if (e.payload.outcome === 'gave_up') problems.push(ptr(e, 'gave_up'));
  const scan = facts.markerScan;
  if (scan !== undefined && scan.maxObjectsPerCommand > 1)
    problems.push(
      `facts.markerScan: ${scan.maxObjectsPerCommand} objects share one commandId`,
    );
  return judged(
    'nf.reliability',
    'non-functional',
    'Reliability: no duplicate dispatch, Issue or PR after any crash window',
    problems,
    [
      `${spawned.length} attempts spawned, ${dispatched.length} dispatches, ${objects.length} Issues/PRs, ${issued.length} commands all resolved`,
      ...(scan === undefined
        ? ['marker scan: not supplied']
        : [
            `facts.markerScan.maxObjectsPerCommand = ${scan.maxObjectsPerCommand}`,
          ]),
    ],
  );
}

/**
 * §20 secret shapes only. The redactor's entropy heuristic is deliberately
 * eager (compound ids trip it), so it cannot judge a log of ids.
 */
const SECRETS = [
  /\b(?:gh[a-z]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|aio_seat_[A-Za-z0-9_-]+)/,
  new RegExp(CONTROL_TOKEN_PREFIX),
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  /\b(?:Bearer|token) [A-Za-z0-9._~+/-]{16,}/,
  /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
];

function masking(log: Log): AcceptanceRow {
  const problems: string[] = [];
  let strings = 0;
  const visit = (e: Ev, value: unknown, path: string) => {
    if (typeof value === 'string') {
      strings += 1;
      if (SECRETS.some((pattern) => pattern.test(value)))
        problems.push(`${ptr(e)} ${path}`);
    } else if (Array.isArray(value))
      value.forEach((item, i) => visit(e, item, `${path}.${i}`));
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value))
        visit(e, item, path ? `${path}.${key}` : key);
  };
  for (const e of log.events) visit(e, e, '');
  return judged(
    'nf.masking',
    'non-functional',
    'Masking: no secret survives in events (§20)',
    problems,
    [`${strings} strings scanned for tokens, control tokens, keys and emails`],
  );
}

function mergeNotDefault(log: Log, facts: AcceptanceFacts): AcceptanceRow {
  const workers = log.workerPrs();
  const finals = new Set<number>(
    log
      .of('artifact.created')
      .filter((e) => e.payload.kind === 'pr' && !workers.has(e.payload.number))
      .map((e) => e.payload.number as number),
  );
  for (const e of log.of('workflow.completed'))
    if (typeof e.payload.finalPr === 'number') finals.add(e.payload.finalPr);
  const problems: string[] = [];
  const merges = log.mergePrCommands();
  for (const { issued, pr } of merges)
    if (finals.has(pr) || !workers.has(pr))
      problems.push(`${ptr(issued, `PR #${pr}`)} is not a worker PR`);
  for (const e of log.of('anomaly.detected'))
    if (e.payload.kind === 'default-branch-moved')
      problems.push(ptr(e, 'default-branch-moved'));
  if (facts.defaultBranchMovedOnlyByOwner === false)
    problems.push('facts.defaultBranchMovedOnlyByOwner = false');
  return judged(
    'nf.merge-default-branch',
    'non-functional',
    'Security: mergePR never targets the default branch',
    problems,
    [
      `${merges.length} scm.mergePR commands, all on worker PRs; final PR ${[...finals].map((n) => '#' + n).join(', ') || 'none'} never merged by the backend`,
      facts.defaultBranchMovedOnlyByOwner === undefined
        ? 'activity check: not supplied (adapter guard: CI)'
        : 'facts.defaultBranchMovedOnlyByOwner = true',
    ],
  );
}

function approveComment(facts: AcceptanceFacts): AcceptanceRow {
  const title = 'Security: a GitHub /approve comment changes no state';
  if (facts.approveCommentNoStateChange === undefined)
    return external(
      'nf.approve-comment',
      'non-functional',
      title,
      'CI (M3-T15 step 10); live: facts.approveCommentNoStateChange',
    );
  return judged(
    'nf.approve-comment',
    'non-functional',
    title,
    facts.approveCommentNoStateChange
      ? []
      : ['facts.approveCommentNoStateChange = false'],
    ['facts.approveCommentNoStateChange'],
  );
}

/** §27 invariant from the log: attempts spawned and not yet released or exited. */
function liveAtStageGates(log: Log): { gate: Ev; live: string[] }[] {
  const live = new Set<string>();
  const result: { gate: Ev; live: string[] }[] = [];
  for (const e of log.events) {
    if (e.type === 'seat.spawned') live.add(e.payload.attemptId);
    if (e.type === 'seat.released' || e.type === 'seat.exited')
      live.delete(e.payload.attemptId);
    if (e.type === 'gate.opened' && e.payload.kind === 'stage')
      result.push({ gate: e, live: [...live] });
  }
  return result;
}

function stageGateAgents(log: Log): AcceptanceRow {
  const gates = liveAtStageGates(log);
  return judged(
    'nf.stage-gate-agents',
    'non-functional',
    'Security: zero live agents whenever a stage gate opens (events)',
    [
      ...(gates.length === 0 ? ['no stage gate opened'] : []),
      ...gates
        .filter((g) => g.live.length > 0)
        .map(
          (g) =>
            `${ptr(g.gate, g.gate.payload.stageKind)}: ${g.live.length} live`,
        ),
    ],
    gates.map(
      (g) => `${ptr(g.gate, g.gate.payload.stageKind)}: ${g.live.length} live`,
    ),
  );
}

// --- v0.1 -------------------------------------------------------------------

function decisionGates(log: Log): AcceptanceRow {
  const problems: string[] = [];
  const evidence: string[] = [];
  const decided = log.of('gate.decided');
  for (const kind of ['meeting', 'planning']) {
    const gates = log.stageGates().filter((e) => e.payload.stageKind === kind);
    if (gates.length === 0) problems.push(`no ${kind} gate opened`);
    for (const gate of gates) {
      const decisions = decided.filter(
        (e) => e.payload.gateId === gate.payload.gateId,
      );
      const byUser = decisions.find((e) => e.payload.by === 'user');
      if (
        byUser === undefined ||
        decisions.some((e) => e.payload.by !== 'user')
      )
        problems.push(`${ptr(gate, kind)} not decided by the user`);
      else
        evidence.push(
          `${ptr(gate, kind)} → ${ptr(byUser, byUser.payload.decision)}`,
        );
    }
  }
  const finalGates = log
    .stageGates()
    .filter((e) => e.payload.stageKind === 'final-pr');
  const closed = finalGates
    .map((gate) =>
      log
        .of('gate.closed')
        .find(
          (e) => e.payload.gateId === gate.payload.gateId && e.seq > gate.seq,
        ),
    )
    .find((e) => e?.payload.reason === 'merged');
  const completed = log.of('workflow.completed')[0];
  if (closed === undefined) problems.push('final PR gate not closed by merge');
  else evidence.push(ptr(closed, 'merged'));
  if (completed === undefined) problems.push('no workflow.completed');
  else evidence.push(ptr(completed, `final PR #${completed.payload.finalPr}`));
  return judged(
    'v01.gates',
    'v0.1',
    'User decides the 2 decision gates; the final PR gate closes by merge',
    problems,
    evidence,
  );
}

function onCall(log: Log): AcceptanceRow {
  const forwarded = log
    .of('message.forwarded')
    .filter((e) => e.payload.to === 'on-call');
  const answers = log
    .of('message.answered')
    .filter(
      (a) =>
        a.payload.by === 'agent' &&
        forwarded.some(
          (f) =>
            f.payload.questionId === a.payload.questionId &&
            f.payload.toAttemptId === a.payload.attemptId &&
            f.seq < a.seq,
        ),
    );
  const problems: string[] = [];
  const evidence: string[] = [];
  if (answers.length === 0)
    problems.push('no question answered by the on-call agent');
  for (const attemptId of new Set(answers.map((a) => a.payload.attemptId))) {
    const last = answers
      .filter((a) => a.payload.attemptId === attemptId)
      .at(-1)!;
    const stopped = log
      .of('ondemand.stopped')
      .find(
        (e) =>
          e.payload.purpose === 'oncall' &&
          e.payload.attemptId === attemptId &&
          e.seq > last.seq,
      );
    const gone = [...log.of('seat.released'), ...log.of('seat.exited')].find(
      (e) => e.payload.attemptId === attemptId && e.seq > last.seq,
    );
    if (stopped === undefined || gone === undefined)
      problems.push(
        `on-call attempt that answered at ${ptr(last)} never stopped`,
      );
    else
      evidence.push(
        [last, stopped, gone]
          .sort((a, b) => a.seq - b.seq)
          .map((e) => ptr(e, e === stopped ? e.payload.reason : undefined))
          .join(' → '),
      );
  }
  return judged(
    'v01.oncall',
    'v0.1',
    'At least one worker question answered by on-call, which then stops',
    problems,
    [`${answers.length} on-call answers`, ...evidence],
  );
}

const dependsOn = (item: Json): string[] => item.deps ?? [];

function baseSha(log: Log, facts: AcceptanceFacts): AcceptanceRow {
  const approved = log.of('workitem.approved').at(-1);
  const items: Json[] = approved?.payload.items ?? [];
  const merged = log.of('workitem.merged');
  const problems: string[] = [];
  const evidence: string[] = [];
  let checked = 0;
  for (const item of items.filter((i) => dependsOn(i).length > 0)) {
    const dispatches = log
      .of('workitem.dispatched')
      .filter(
        (e) =>
          e.payload.itemKey === item.key && e.payload.reworkOf === undefined,
      );
    for (const d of dispatches) {
      checked += 1;
      const deps = dependsOn(item).map((key) => ({
        key,
        merge: merged
          .filter((m) => m.payload.itemKey === key && m.seq < d.seq)
          .at(-1),
      }));
      const missing = deps
        .filter((dep) => dep.merge === undefined)
        .map((dep) => dep.key);
      const base = d.payload.baseSha as string | undefined;
      if (missing.length > 0) {
        problems.push(
          `${ptr(d, item.key)} before ${missing.join(', ')} merged`,
        );
        continue;
      }
      if (base === undefined) {
        problems.push(`${ptr(d, item.key)} has no baseSha`);
        continue;
      }
      if (facts.ancestry !== undefined) {
        for (const dep of deps) {
          const fact = facts.ancestry.find(
            (f) =>
              f.baseSha === base &&
              f.commit === dep.merge!.payload.mergeCommitSha,
          );
          if (fact?.isAncestor !== true)
            problems.push(
              `${ptr(d, item.key)}: ${dep.key} merge ${fact === undefined ? 'has no ancestry fact' : 'is not an ancestor'}`,
            );
        }
        evidence.push(
          `${ptr(d, item.key)} base contains ${deps.map((dep) => ptr(dep.merge!, dep.key)).join(', ')} (facts.ancestry)`,
        );
        continue;
      }
      // Structural: during implement the integration branch moves only by
      // merge commits, so a base equal to a merge at or after every dependency
      // merge contains them all.
      const after = Math.max(...deps.map((dep) => dep.merge!.seq));
      const at = merged.find(
        (m) =>
          m.payload.mergeCommitSha === base && m.seq >= after && m.seq < d.seq,
      );
      if (at === undefined)
        problems.push(
          `${ptr(d, item.key)} base is not an integration merge after its dependencies`,
        );
      else
        evidence.push(
          `${ptr(d, item.key)} base = ${ptr(at, at.payload.itemKey)} merge (structural; no ancestry facts)`,
        );
    }
  }
  if (checked === 0)
    problems.push('no dispatch of a work item with dependencies');
  return judged(
    'v01.base-sha',
    'v0.1',
    'Downstream workitem.dispatched.baseSha contains the dependency merge commits',
    problems,
    evidence,
  );
}

function rework(log: Log, facts: AcceptanceFacts): AcceptanceRow {
  const problems: string[] = [];
  const evidence: string[] = [];
  const trips: number[] = [];
  for (const r of log.of('workitem.rework_requested')) {
    const { itemKey, pr } = r.payload;
    const original = log
      .of('workitem.dispatched')
      .filter((e) => e.payload.itemKey === itemKey && e.seq < r.seq)
      .at(-1);
    const again = log
      .of('workitem.dispatched')
      .find(
        (e) =>
          e.payload.itemKey === itemKey &&
          e.seq > r.seq &&
          e.payload.reworkOf !== undefined,
      );
    const queued =
      again &&
      log
        .of('workitem.merge_queued')
        .find((e) => e.payload.itemKey === itemKey && e.seq > again.seq);
    const merged =
      queued &&
      log
        .of('workitem.merged')
        .find((e) => e.payload.itemKey === itemKey && e.seq > queued.seq);
    if (
      again === undefined ||
      again.payload.branch !== original?.payload.branch
    )
      problems.push(`${ptr(r, itemKey)}: no rework attempt on the same branch`);
    else if (queued?.payload.pr !== pr || merged?.payload.pr !== pr)
      problems.push(
        `${ptr(r, itemKey)}: not re-reviewed and merged on PR #${pr}`,
      );
    else {
      trips.push(pr);
      evidence.push(
        `${ptr(r, `${itemKey} PR #${pr}`)} → ${ptr(again)} → ${ptr(queued!)} → ${ptr(merged!)}`,
      );
    }
  }
  if (trips.length === 0 && problems.length === 0)
    problems.push('no rework-request');
  if (facts.rework !== undefined) {
    const proven = facts.rework.filter((f) => trips.includes(f.pr));
    for (const f of proven)
      if (!f.firstHeadHasPending || !f.finalHeadHasPrNumber || !f.lineByWorker)
        problems.push(
          `facts.rework PR #${f.pr}: #pending line not proven (§2.2.3)`,
        );
    if (proven.length === 0) problems.push('facts.rework covers no round trip');
    else
      evidence.push(
        `facts.rework: ${proven.map((f) => '#' + f.pr).join(', ')}`,
      );
  } else evidence.push('#pending content facts: not supplied');
  return judged(
    'v01.rework',
    'v0.1',
    'At least one rework-request round trip on the same PR',
    problems,
    evidence,
  );
}

/**
 * §2.2.2. SCM-observed state is judged from the PR's own status history, not
 * from the global ingest seq: polls can deliver a PR's statuses after the
 * backend already merged it (scm-github stamps them with the PR's
 * `updated_at` at poll time, so their time cannot order them either). A
 * conflict is handled when the PR's history shows `mergeable:false` and the
 * backend recorded `workitem.merged` for that PR (any seq) — the PR's later
 * `merged` status, or a merge ingested after the false status, confirms it.
 * Live runs back path A with `facts.conflict` (the two-parent merge).
 */
function conflict(log: Log, facts: AcceptanceFacts): AcceptanceRow {
  const workers = log.workerPrs();
  const problems: string[] = [];
  const evidence: string[] = [];
  const history = new Map<number, Ev[]>();
  for (const e of log.of('pr.status'))
    if (workers.has(e.payload.pr))
      history.set(e.payload.pr, [...(history.get(e.payload.pr) ?? []), e]);
  const firstFalse = new Map<number, Ev>();
  for (const [pr, statuses] of history) {
    const seen = statuses.find((e) => e.payload.mergeable === false);
    if (seen) firstFalse.set(pr, seen);
  }
  if (firstFalse.size === 0)
    problems.push('no worker PR reported mergeable:false');
  for (const [pr, seen] of firstFalse) {
    const itemKey = log.itemOfPr(pr);
    const statuses = history.get(pr)!;
    const scmMerged = statuses
      .slice(statuses.indexOf(seen) + 1)
      .find((e) => e.payload.state === 'merged');
    const merged = log.of('workitem.merged').find((e) => e.payload.pr === pr);
    // Status ingested after the merge: look for paths B and C from the PR's
    // entry into the merge queue instead of from the (late) false status.
    const lagged = merged !== undefined && merged.seq < seen.seq;
    const from = lagged
      ? (log.of('workitem.merge_queued').find((e) => e.payload.pr === pr)
          ?.seq ?? 0)
      : seen.seq;
    const after = (e: Ev) => e.seq > from;
    const mergeCommands = new Set(
      log
        .mergePrCommands()
        .filter((c) => c.pr === pr)
        .map((c) => c.issued.payload.commandId),
    );
    const pathC =
      log
        .of('command.failed')
        .find(
          (e) =>
            after(e) &&
            e.payload.error?.category === 'conflict' &&
            mergeCommands.has(e.payload.commandId),
        ) ??
      log
        .of('gate.opened')
        .find(
          (e) =>
            after(e) &&
            e.payload.kind === 'exception' &&
            ['merge-blocked', 'decision-request'].includes(
              e.payload.exceptionKind,
            ) &&
            e.payload.content?.itemKey === itemKey,
        );
    const pathB = log
      .of('workitem.rework_requested')
      .find((e) => e.payload.pr === pr && after(e));
    const path = pathC ? 'C' : pathB ? 'B' : 'A';
    const label = `PR #${pr}${itemKey === undefined ? '' : ` (${itemKey})`}: path ${path}`;
    if (merged === undefined) {
      problems.push(
        scmMerged
          ? `${label} merged (${ptr(scmMerged)}) without a backend workitem.merged`
          : `${label} never merged after ${ptr(seen)}`,
      );
      continue;
    }
    if (lagged && scmMerged === undefined) {
      problems.push(
        `${label}: ${ptr(merged)} precedes ${ptr(seen)} and the PR history shows no later merge`,
      );
      continue;
    }
    const fact = facts.conflict?.find((f) => f.pr === pr);
    if (path === 'A' && fact?.twoParentMerge === false)
      problems.push(`${label}: facts.conflict shows no two-parent merge`);
    evidence.push(
      `${label}, ${ptr(seen, 'mergeable=false')} → ${pathC ? ptr(pathC) + ' → ' : pathB ? ptr(pathB) + ' → ' : ''}${ptr(merged)}` +
        (lagged
          ? ` (status ingested after the merge; PR history: ${ptr(scmMerged!, 'merged')})`
          : '') +
        (path === 'A'
          ? fact
            ? ' (facts.conflict)'
            : ' (two-parent merge fact not supplied)'
          : ' (variance)'),
    );
  }
  return judged(
    'v01.conflict',
    'v0.1',
    'Forced conflict handled (§2.2.2 path A integrator, B rework, C exception gate)',
    problems,
    evidence,
  );
}

function integrationBranch(log: Log, facts: AcceptanceFacts): AcceptanceRow {
  const problems: string[] = [];
  const merged = log.of('workitem.merged');
  const backend = new Set(
    log
      .of('command.succeeded')
      .filter((e) => e.payload.kind === 'scm.mergePR')
      .map((e) => e.payload.result?.mergeCommitSha),
  );
  if (merged.length === 0) problems.push('no backend merge');
  for (const m of merged)
    if (!backend.has(m.payload.mergeCommitSha))
      problems.push(`${ptr(m, m.payload.itemKey)} has no scm.mergePR result`);
  for (const e of log.of('anomaly.detected'))
    if (
      ['integration-branch-moved', 'unmanaged-merge', 'early-merge'].includes(
        e.payload.kind,
      )
    )
      problems.push(ptr(e, e.payload.kind));
  const order = merged.map((m) => m.payload.mergeCommitSha as string);
  const fp = facts.integrationFirstParent;
  if (fp !== undefined && fp.join() !== order.join())
    problems.push(
      'facts.integrationFirstParent differs from the workitem.merged order',
    );
  return judged(
    'v01.integration-branch',
    'v0.1',
    'Implement: the integration branch advances only by backend merges',
    problems,
    [
      `${merged.length} merges, each an scm.mergePR result: ${merged.map((m) => ptr(m, m.payload.itemKey)).join(', ')}`,
      fp === undefined
        ? 'first-parent facts: not supplied'
        : 'facts.integrationFirstParent matches',
    ],
  );
}

function workerList(log: Log, facts: AcceptanceFacts): AcceptanceRow {
  const title =
    'Every stage gate opens with no live agent in worker-list --run';
  const observed = facts.workerListAtStageGates;
  if (observed === undefined)
    return external(
      'v01.worker-list',
      'v0.1',
      title,
      'harness observation: facts.workerListAtStageGates (T7)',
    );
  const problems: string[] = [];
  for (const gate of log.stageGates())
    if (!observed.some((o) => matchesFact(gate.payload.gateId, o.gateId)))
      problems.push(
        `${ptr(gate, gate.payload.stageKind)} has no worker-list observation`,
      );
  for (const o of observed)
    if (o.liveAgents > 0)
      problems.push(`worker-list showed ${o.liveAgents} live at ${o.gateId}`);
  return judged('v01.worker-list', 'v0.1', title, problems, [
    `${observed.length} worker-list observations (facts.workerListAtStageGates)`,
  ]);
}

function waitingInput(log: Log): AcceptanceRow {
  const waiting = log
    .of('seat.status')
    .filter((e) => e.payload.state === 'waiting_input');
  return judged(
    'v01.waiting-input',
    'v0.1',
    'Office reflects each agent state, with at least one waiting_input',
    waiting.length === 0 ? ['no seat.status waiting_input'] : [],
    [
      ...waiting.slice(0, 3).map((e) => ptr(e, 'waiting_input')),
      'UI rendering: T17',
    ],
  );
}

function replay(log: Log): AcceptanceRow {
  const problems: string[] = [];
  let gaps = 0;
  log.events.forEach((e, i) => {
    const prev = log.events[i - 1];
    if (prev !== undefined && e.seq <= prev.seq)
      problems.push(`${ptr(e)} out of order after #${prev.seq}`);
    if (prev !== undefined && e.seq > prev.seq + 1) gaps += 1;
  });
  if (log.of('workflow.started').length !== 1)
    problems.push('expected exactly one workflow.started');
  const first = log.events[0];
  const last = log.events.at(-1);
  return judged(
    'v01.replay',
    'v0.1',
    'The finished flow replays completely on the timeline',
    problems,
    [
      first && last
        ? `seq #${first.seq}…#${last.seq} ascending, ${log.events.length} events, ${gaps} gaps (other streams)`
        : 'empty log',
      'timeline scrub: T17',
    ],
  );
}

function usage(log: Log): AcceptanceRow {
  const problems: string[] = [];
  const tokens = log.of('usage.tokens');
  if (tokens.length === 0) problems.push('no usage.tokens');
  for (const e of tokens)
    if (!e.externalKey) problems.push(`${ptr(e)} has no externalKey`);
  for (const key of duplicates(
    tokens.map((e) => e.externalKey).filter(Boolean),
  ))
    problems.push(
      `usage externalKey repeated: ${ptr(tokens.find((e) => e.externalKey === key)!)}`,
    );
  const enforcement =
    log.of('workflow.started')[0]?.payload.limits?.budgetEnforcement;
  const budget = [...log.of('budget.exceeded'), ...log.of('budget.hard_limit')];
  if (enforcement === 'off')
    for (const e of budget) problems.push(`${ptr(e)} with enforcement off`);
  return judged(
    'v01.usage',
    'v0.1',
    'Token usage recorded once each; enforcement = off ⇒ 0 budget.*',
    problems,
    [
      `${tokens.length} usage.tokens, externalKeys unique`,
      enforcement === 'off'
        ? `enforcement off: ${budget.length} budget.*`
        : `enforcement ${enforcement ?? 'unknown'}: budget part N/A`,
      'display: T17',
    ],
  );
}

// --- extra -------------------------------------------------------------------

function noDuplicates(log: Log): AcceptanceRow {
  const problems: string[] = [];
  const first = (pick: (e: Ev) => unknown, value: unknown) =>
    ptr(log.events.find((e) => pick(e) === value)!);
  const checks: [string, (e: Ev) => unknown, Ev[]][] = [
    ['seq', (e) => e.seq, log.events],
    ['event id', (e) => e.id, log.events.filter((e) => e.id !== undefined)],
    [
      'externalKey',
      (e) => e.externalKey,
      log.events.filter((e) => e.externalKey),
    ],
    [
      'commandId issued',
      (e) => e.type === 'command.issued' && e.payload.commandId,
      log.of('command.issued'),
    ],
    [
      'command result',
      (e) =>
        (e.type === 'command.succeeded' || e.type === 'command.failed') &&
        e.payload.commandId,
      [...log.of('command.succeeded'), ...log.of('command.failed')],
    ],
  ];
  for (const [what, pick, events] of checks)
    for (const value of duplicates(events.map(pick)))
      problems.push(`${what} repeated: ${first(pick, value)}`);
  return judged(
    'x.no-duplicates',
    'extra',
    'No duplicate facts or commands',
    problems,
    [
      `${log.events.length} events: seq, ids, externalKeys, commandIds and command results unique`,
    ],
  );
}

export function checkAcceptance(
  rawEvents: readonly Json[],
  facts: AcceptanceFacts = {},
): AcceptanceReport {
  const log = new Log(rawEvents);
  const rows = [
    latency(log),
    activityLatency(log),
    external(
      'nf.cpu',
      'non-functional',
      'CPU: Orca CLI ≤ 120 calls/min',
      'T7 sampler peak (T11b, T12)',
    ),
    external(
      'nf.fps',
      'non-functional',
      'Scale: 10 agents at 60 fps',
      'M4 load-10; T17 e2e:fps',
    ),
    reliability(log, facts),
    masking(log),
    external(
      'nf.auth',
      'non-functional',
      'Security: requests without session/Host/Origin rejected',
      'CI (M1 API tests, T6 endpoint)',
    ),
    mergeNotDefault(log, facts),
    approveComment(facts),
    stageGateAgents(log),
    external(
      'nf.boundaries',
      'non-functional',
      'Boundaries: depcruise, tsc -b, typecheck:tests, bundle, contracts',
      'CI (DoD)',
    ),
    external(
      'nf.coverage',
      'non-functional',
      'Tests: domain/engine/projection ≥ 90%, transition list green',
      'CI (DoD)',
    ),
    decisionGates(log),
    onCall(log),
    baseSha(log, facts),
    rework(log, facts),
    integrationBranch(log, facts),
    workerList(log, facts),
    waitingInput(log),
    replay(log),
    usage(log),
    conflict(log, facts),
    noDuplicates(log),
    external(
      'x.engine-replay',
      'extra',
      'Engine consistency replay (optional)',
      'not implemented: decide() needs the full engine state per stage',
    ),
  ];
  const summary: Record<Verdict, number> = { pass: 0, fail: 0, na: 0 };
  for (const r of rows) summary[r.verdict] += 1;
  return { rows, summary };
}

const MARK: Record<Verdict, string> = { pass: '✅', fail: '❌', na: 'N/A' };

export function formatReport(report: AcceptanceReport): string {
  const lines = report.rows.flatMap((r) => [
    `${MARK[r.verdict]} ${r.id} — ${r.title}`,
    ...r.evidence.map((e) => `    ${e}`),
  ]);
  const { pass, fail, na } = report.summary;
  return [...lines, `${pass} ✅  ${fail} ❌  ${na} N/A`].join('\n');
}
