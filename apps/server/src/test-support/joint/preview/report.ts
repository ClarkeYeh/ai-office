/**
 * M5-T11b report pieces (M5_PLAN §5 T11b, §2.6): the private usage ledger for
 * T13 and the must/should behaviour verdicts. Pure over the event log, the
 * drill report and the T10 checker rows. Numbers, ids, enums and booleans only.
 */
import { usageByRole, type Json } from '../../orca/t17/checks.js';
import { CONFLICT_KEYS, ESCALATION_KEY } from '../scenario/index.js';

const of = (log: Json[], type: string) => log.filter((e) => e.type === type);

/**
 * T13 samples: per attempt (stage, role, agent, item) the summed token deltas
 * and turns, plus the per-role totals. Never bodies or session ids.
 */
export function usageLedger(log: Json[], tag: string) {
  const attempts = new Map<string, Json>();
  for (const e of of(log, 'seat.spawned'))
    attempts.set(e.payload.attemptId, {
      stageId: e.payload.stageId,
      role: e.payload.role,
      agent: e.payload.agent,
      purpose: e.payload.purpose,
      ...(e.payload.itemKey ? { itemKey: e.payload.itemKey } : {}),
      inputUncached: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      budgetTokens: 0,
      turns: 0,
      samples: 0,
    });
  for (const e of of(log, 'usage.tokens')) {
    const a = attempts.get(e.payload.attemptId);
    if (!a) continue;
    for (const k of [
      'inputUncached',
      'output',
      'cacheRead',
      'cacheWrite',
      'reasoning',
      'budgetTokens',
    ])
      a[k] += Number(e.payload[k] ?? 0);
    a.samples++;
  }
  for (const e of of(log, 'usage.turns')) {
    const a = attempts.get(e.payload.attemptId);
    if (a) a.turns += Number(e.payload.turns ?? 0);
  }
  return {
    scenario: 'm5-mainline',
    run: 't11b-preview',
    tag,
    attempts: [...attempts.values()].filter((a) => a.samples > 0),
    byRole: usageByRole(log),
  };
}

export type Level = 'must' | 'should';
export interface Behaviour {
  id: string;
  level: Level;
  ok: boolean | 'n/a';
  evidence: Record<string, number | boolean | string | null>;
}

interface Inputs {
  log: Json[];
  /** The drill's private report. */
  report: Json;
  /** T10 checker verdicts by row id (masked export). */
  rows: Record<string, 'pass' | 'fail' | 'na'>;
  /** The checker's `v01.conflict` evidence lines (path A/B/C). */
  conflictEvidence?: string[];
  /** scm-gitremote equivalent when the checker row is n/a (no `mergeable`). */
  conflictEquivalent?: { path: 'A' | 'B' | null; item: string } | null;
  /** `node --test m5/<tag>` on the final integration head. */
  testsPass?: boolean;
  /** calc.mjs on the final integration head exports add, mul and sub. */
  bothOps?: boolean;
}

/** §2.6 for T11b (the hand merge is replaced by the stand-in's explicit merge). */
export function behaviours(x: Inputs): Behaviour[] {
  const merged = of(x.log, 'workitem.merged');
  const assertions = (x.report.assertions ?? []) as Json[];
  const restartOk =
    x.report.killed === true &&
    assertions.length > 0 &&
    assertions.every((a) => a.status !== 'fail');
  const conflictPath =
    /path ([ABC])/.exec((x.conflictEvidence ?? []).join(' '))?.[1] ??
    (x.rows['v01.conflict'] === 'na'
      ? (x.conflictEquivalent?.path ?? undefined)
      : undefined);
  const conflictPr = new Set(
    of(x.log, 'pr.status')
      .filter((e) => e.payload.mergeable === false)
      .map((e) => e.payload.pr),
  );
  const conflictItems = of(x.log, 'workitem.merge_queued')
    .filter((e) => conflictPr.has(e.payload.pr))
    .map((e) => e.payload.itemKey as string);
  const stageGates = (x.report.stageGates ?? []) as Json[];
  return [
    {
      id: 'items-deps-baseSha',
      level: 'must',
      ok:
        new Set(merged.map((e) => e.payload.itemKey)).size >= 4 &&
        x.rows['v01.base-sha'] === 'pass',
      evidence: {
        itemsMerged: new Set(merged.map((e) => e.payload.itemKey)).size,
        baseSha: x.rows['v01.base-sha'] ?? null,
      },
    },
    {
      id: 'rework-round-trip',
      level: 'must',
      ok: x.rows['v01.rework'] === 'pass',
      evidence: {
        reworkRequests: of(x.log, 'workitem.rework_requested').length,
        checker: x.rows['v01.rework'] ?? null,
      },
    },
    {
      id: 'conflict-handled',
      level: 'must',
      ok:
        (x.rows['v01.conflict'] === 'pass' ||
          (x.rows['v01.conflict'] === 'na' && conflictPath !== undefined)) &&
        x.bothOps === true &&
        x.testsPass === true,
      evidence: {
        checker: x.rows['v01.conflict'] ?? null,
        path: conflictPath ?? null,
        conflictOnMulOrSub:
          conflictItems.some((k) =>
            (CONFLICT_KEYS as readonly string[]).includes(k),
          ) ||
          (CONFLICT_KEYS as readonly string[]).includes(
            x.conflictEquivalent?.item ?? '',
          ),
        bothOps: x.bothOps ?? null,
        testsPass: x.testsPass ?? null,
      },
    },
    {
      id: 'oncall-answered-then-stopped',
      level: 'must',
      ok: x.rows['v01.oncall'] === 'pass',
      evidence: { checker: x.rows['v01.oncall'] ?? null },
    },
    {
      id: 'escalated-to-owner',
      level: 'should',
      ok:
        x.report.owner?.escalation === undefined
          ? false
          : x.report.escalationAnsweredByOwner === true,
      evidence: {
        escalations: of(x.log, 'message.escalated').length,
        escalatedItemIsName: of(x.log, 'message.escalated').length > 0,
        releasedBy: x.report.owner?.escalation?.releasedBy ?? null,
        codeNameIsAnswer: x.report.codeNameIsAnswer ?? null,
        item: ESCALATION_KEY,
      },
    },
    {
      id: 'restart-once-all-assertions',
      level: 'must',
      ok: restartOk,
      evidence: {
        killed: x.report.killed ?? null,
        trigger: x.report.trigger ?? null,
        failedAssertions:
          assertions
            .filter((a) => a.status === 'fail')
            .map((a) => a.id)
            .join(',') || null,
      },
    },
    {
      id: 'no-live-agent-at-stage-gates',
      level: 'must',
      ok:
        stageGates.length > 0 &&
        stageGates.every((g) => g.live === 0) &&
        x.rows['nf.stage-gate-agents'] === 'pass',
      evidence: {
        stageGates: stageGates.length,
        withLiveAgents: stageGates.filter((g) => g.live !== 0).length,
      },
    },
    {
      id: 'final-pr-merged-explicitly',
      level: 'must',
      ok:
        x.report.status === 'completed' &&
        of(x.log, 'gate.closed').some((e) => e.payload.reason === 'merged'),
      evidence: { status: x.report.status ?? null },
    },
  ];
}

/**
 * Which side of `POST /merges` the kill landed on (§2.3.2): the K command's
 * reconcile outcome — `found` (merged before the kill), `redone` (not yet),
 * or none when it had settled before the kill.
 */
export function killSide(log: Json[], triggerSeq: number | undefined) {
  if (triggerSeq === undefined) return 'no-kill';
  const issued = log.find(
    (e) => e.type === 'command.issued' && Number(e.seq) === triggerSeq,
  );
  const id = issued?.payload.commandId;
  const outcome = log.find(
    (e) => e.type === 'command.reconciled' && e.payload.commandId === id,
  )?.payload.outcome as string | undefined;
  if (outcome === 'found') return 'after-merge';
  if (outcome === 'redone') return 'before-merge';
  return log.some(
    (e) =>
      (e.type === 'command.succeeded' || e.type === 'command.failed') &&
      e.payload.commandId === id,
  )
    ? 'settled-before-kill'
    : 'unknown';
}
