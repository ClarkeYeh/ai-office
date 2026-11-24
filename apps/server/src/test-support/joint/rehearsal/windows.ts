/**
 * M5-T11 judgement of each kill window separately (M5_PLAN §2.4, §5 T11),
 * pure over the event log plus the window's SCM fact:
 * - the window's command was issued and had no result when the child died;
 * - after the restart it has exactly one terminal event, `command.succeeded`,
 *   with `command.reconciled{found|redone}` and no `gave_up`;
 * - it was never issued again;
 * - exactly one external object: one Issue carrying its marker (P1), one
 *   merge commit of the PR on the integration branch (P2);
 * - ready including reconcile ≤ 60 s (§2.3.3).
 * Also the segment-1 semantics (everything before the first kill) that the CI
 * twin compares with the live trace (M3-T15 ruling: event semantics, not a
 * call-by-call HTTP replay).
 */
import type { Json } from '../../orca/t17/checks.js';
import type { RestartRecord } from '../restart.js';
import type { PauseHit } from './pause.js';
import type { RehearsalWindow } from './protocol.js';

export const READY_WITH_RECONCILE_MS = 60_000;

export interface WindowEvidence {
  window: RehearsalWindow;
  hit: PauseHit;
  /** Highest seq the harness saw before the kill. */
  killSeq: number;
  restart: RestartRecord;
  /** Restart issued → the window command's terminal event was observed. */
  reconcileMs: number | undefined;
  /** P1: Issues with the command's marker; P2: merge commits of the PR. */
  objects: number | undefined;
}

export interface WindowRow {
  id: string;
  status: 'pass' | 'fail';
  detail: string;
}

const KIND: Record<RehearsalWindow, string> = {
  P1: 'scm.createIssue',
  P2: 'scm.mergePR',
};
const TERMINAL = ['command.succeeded', 'command.failed'];

/** The engine commandId the window withheld (P2: by PR number). */
export function windowCommand(
  events: Json[],
  hit: PauseHit,
  killSeq: number,
): string | undefined {
  if (hit.window === 'P1') return hit.commandId;
  return events
    .filter(
      (e) =>
        e.type === 'command.issued' &&
        e.payload.kind === KIND.P2 &&
        e.payload.args?.pr?.number === hit.pr &&
        Number(e.seq) <= killSeq,
    )
    .at(-1)?.payload.commandId as string | undefined;
}

/** Ready including reconcile: the later of runtime.json and the terminal event. */
export function readyWithReconcileMs(w: WindowEvidence): number | undefined {
  return w.reconcileMs === undefined
    ? undefined
    : Math.max(w.restart.readyMs, w.reconcileMs);
}

export function windowAssertions(
  events: Json[],
  w: WindowEvidence,
): WindowRow[] {
  const id = windowCommand(events, w.hit, w.killSeq);
  const rows: WindowRow[] = [];
  const add = (name: string, ok: boolean, detail: string) =>
    rows.push({
      id: `${w.window}.${name}`,
      status: ok ? 'pass' : 'fail',
      detail,
    });
  const mine = events.filter((e) => e.payload?.commandId === id);
  const issued = mine.filter((e) => e.type === 'command.issued');
  const terminal = mine.filter((e) => TERMINAL.includes(e.type));
  const reconciled = mine.filter((e) => e.type === 'command.reconciled');
  add(
    'pending-at-kill',
    id !== undefined &&
      issued.some(
        (e) => e.payload.kind === KIND[w.window] && Number(e.seq) <= w.killSeq,
      ) &&
      terminal.every((e) => Number(e.seq) > w.killSeq),
    `command ${id ? 'found' : 'missing'}; issued ${issued.length}, terminal before kill ${terminal.filter((e) => Number(e.seq) <= w.killSeq).length}`,
  );
  add(
    'one-terminal',
    terminal.length === 1 && terminal[0]!.type === 'command.succeeded',
    `terminal events ${terminal.map((e) => e.type).join(',') || 'none'}`,
  );
  const outcomes = reconciled.map((e) => String(e.payload.outcome));
  add(
    'reconciled',
    outcomes.length === 1 &&
      (outcomes[0] === 'found' || outcomes[0] === 'redone'),
    `command.reconciled ${outcomes.join(',') || 'none'}`,
  );
  add('not-reissued', issued.length === 1, `issued ${issued.length}`);
  add(
    w.window === 'P1' ? 'one-issue' : 'one-merge',
    w.objects === 1,
    `${w.window === 'P1' ? 'Issues with the marker' : 'merge commits of the PR'}: ${w.objects ?? 'unknown'}`,
  );
  if (w.window === 'P2') {
    const merged = events.filter(
      (e) => e.type === 'workitem.merged' && e.payload.pr === w.hit.pr,
    );
    add(
      'merged-once',
      merged.length === 1 &&
        merged[0]!.payload.mergeCommitSha === w.hit.mergeCommitSha,
      `workitem.merged ${merged.length}; same commit as the withheld merge: ${merged[0]?.payload.mergeCommitSha === w.hit.mergeCommitSha}`,
    );
  }
  const ready = readyWithReconcileMs(w);
  add(
    'ready-60s',
    ready !== undefined && ready <= READY_WITH_RECONCILE_MS,
    `ready incl. reconcile ${ready ?? 'unknown'} ms (runtime.json ${w.restart.readyMs} ms)`,
  );
  return rows;
}

/**
 * Segment 1 semantics: the stage and gate flow (ordered) and the multiset of
 * issued command kinds up to the first kill, plus the withheld command kind.
 * Ids, SHAs, bodies and timing are left out.
 */
export function segmentSemantics(events: Json[], killSeq: number) {
  const before = events.filter((e) => Number(e.seq) <= killSeq);
  const flow: string[] = [];
  for (const { type, payload: p } of before) {
    if (type === 'workflow.started') flow.push(type);
    else if (type === 'stage.started')
      flow.push(`${type} ${p.stageId} ${p.mode}`);
    else if (type === 'stage.completed') flow.push(`${type} ${p.stageId}`);
    else if (type === 'gate.opened')
      flow.push(`${type} ${p.stageId ?? ''} ${p.kind}`.replace(/\s+/g, ' '));
    else if (type === 'gate.closed') flow.push(`${type} ${p.reason}`);
  }
  const commands = before
    .filter((e) => e.type === 'command.issued')
    .map((e) => String(e.payload.kind))
    .sort();
  return { flow, commands };
}
export type SegmentSemantics = ReturnType<typeof segmentSemantics>;
