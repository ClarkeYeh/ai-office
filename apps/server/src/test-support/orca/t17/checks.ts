/**
 * M2-T17: pure checks over a workflow event log (SPEC §27 M2 criteria). The
 * live scenarios feed real logs; `checks.test.ts` pins them with synthetic logs.
 * Only numbers, ids and event types leave these functions — never bodies.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON over HTTP
export type Json = Record<string, any>;

export interface AttemptInfo {
  attemptId: string;
  stageId: string;
  role: string;
  agent: string;
  purpose: string;
  itemKey?: string;
}

export const attempts = (events: Json[]): Map<string, AttemptInfo> =>
  new Map(
    events
      .filter((e) => e.type === 'seat.spawned')
      .map((e) => [
        e.payload.attemptId as string,
        {
          attemptId: e.payload.attemptId,
          stageId: e.payload.stageId,
          role: e.payload.role,
          agent: e.payload.agent,
          purpose: e.payload.purpose,
          ...(e.payload.itemKey ? { itemKey: e.payload.itemKey } : {}),
        },
      ]),
  );

export interface UsageRow {
  stageId: string;
  role: string;
  agent: string;
  attempts: number;
  inputUncached: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  budgetTokens: number;
  turns: number;
}

/**
 * Per stage × role × agent totals for T18. `usage.tokens` / `usage.turns` are
 * per-ingest deltas (domain `evolve` accumulates them), so they are summed.
 */
export function usageByRole(events: Json[]): UsageRow[] {
  const info = attempts(events);
  const rows = new Map<string, UsageRow & { ids: Set<string> }>();
  const row = (attemptId: string) => {
    const a = info.get(attemptId);
    const key = `${a?.stageId ?? '?'}|${a?.role ?? '?'}|${a?.agent ?? '?'}`;
    let r = rows.get(key);
    if (!r) {
      r = {
        stageId: a?.stageId ?? '?',
        role: a?.role ?? '?',
        agent: a?.agent ?? '?',
        attempts: 0,
        inputUncached: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        budgetTokens: 0,
        turns: 0,
        ids: new Set(),
      };
      rows.set(key, r);
    }
    if (!r.ids.has(attemptId)) {
      r.ids.add(attemptId);
      r.attempts++;
    }
    return r;
  };
  for (const e of events) {
    if (e.type === 'usage.tokens') {
      const r = row(e.payload.attemptId);
      for (const k of [
        'inputUncached',
        'output',
        'cacheRead',
        'cacheWrite',
        'budgetTokens',
      ] as const)
        r[k] += Number(e.payload[k] ?? 0);
    }
    if (e.type === 'usage.turns')
      row(e.payload.attemptId).turns += Number(e.payload.turns ?? 0);
  }
  return [...rows.values()]
    .map(({ ids, ...r }) => {
      void ids;
      return r;
    })
    .sort((a, b) =>
      `${a.stageId}${a.role}`.localeCompare(`${b.stageId}${b.role}`),
    );
}

/** §7.1: state transitions observed per agent kind. */
export function statesByAgent(events: Json[]): Record<string, string[]> {
  const info = attempts(events);
  const out: Record<string, Set<string>> = {};
  for (const e of events)
    if (e.type === 'seat.status') {
      const agent = info.get(e.payload.attemptId)?.agent ?? '?';
      (out[agent] ??= new Set()).add(e.payload.state);
    }
  return Object.fromEntries(
    Object.entries(out).map(([k, v]) => [k, [...v].sort()]),
  );
}

/** Agent kinds with at least one accepted submission (submit + identity check). */
export function submittingAgents(events: Json[]): string[] {
  const info = attempts(events);
  return [
    ...new Set(
      events
        .filter((e) => e.type === 'submission.accepted')
        .map((e) => info.get(e.payload.attemptId)?.agent ?? '?'),
    ),
  ].sort();
}

export const count = (events: Json[], type: string): number =>
  events.filter((e) => e.type === type).length;

/** (c) of the spawn-stall acceptance: no stall nudge and no spawn-stall gate. */
export function spawnStallFalsePositives(events: Json[]): {
  nudges: number;
  gates: number;
} {
  return {
    nudges: events.filter(
      (e) => e.type === 'message.nudge' && e.payload.reason === 'spawn-stall',
    ).length,
    gates: events.filter(
      (e) =>
        e.type === 'gate.opened' && e.payload.exceptionKind === 'spawn-stall',
    ).length,
  };
}

/** Attempts that ever reported `error` (escalations must never become errors). */
export const errorAttempts = (events: Json[]): string[] => [
  ...new Set(
    events
      .filter((e) => e.type === 'seat.status' && e.payload.state === 'error')
      .map((e) => e.payload.attemptId as string),
  ),
];

/**
 * Restart dedupe: domain facts that a re-ingested mailbox message would
 * repeat. Returns the duplicated keys (expected empty).
 */
export function duplicatedFacts(events: Json[]): string[] {
  const seen = new Map<string, number>();
  for (const e of events) {
    let key: string | undefined;
    if (e.type === 'submission.accepted')
      key = `${e.type}:${e.payload.submissionId}`;
    else if (e.type === 'message.question')
      key = `${e.type}:${e.payload.questionId}`;
    else if (e.type === 'seat.exited') key = `${e.type}:${e.payload.attemptId}`;
    else if (e.type === 'seat.spawned')
      key = `${e.type}:${e.payload.attemptId}`;
    if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
}

/** S26 evidence: rate-limit windows per attempt (count, total ms, evidence kinds). */
export function rateLimitReport(
  events: Json[],
  now = Date.now(),
): { windows: number; totalMs: number; evidence: string[] } {
  const open = new Map<string, number>();
  let windows = 0,
    totalMs = 0;
  const evidence = new Set<string>();
  for (const e of events) {
    if (e.type !== 'seat.status' || e.payload.rateLimited === undefined)
      continue;
    const id = e.payload.attemptId as string;
    const at = Date.parse(e.occurredAt ?? '') || now;
    if (e.payload.rateLimited) {
      if (!open.has(id)) {
        open.set(id, at);
        windows++;
      }
      const kind = e.payload.rateLimited.evidence;
      if (typeof kind === 'string') evidence.add(kind);
    } else if (open.has(id)) {
      totalMs += at - open.get(id)!;
      open.delete(id);
    }
  }
  for (const start of open.values()) totalMs += now - start;
  return { windows, totalMs, evidence: [...evidence].sort() };
}

/**
 * Follow-up sends per attempt (`attemptId` is on the envelope): the "turn
 * start unobserved" case must never resend (exactly one per turn).
 */
export function sendsPerAttempt(events: Json[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events)
    if (e.type === 'command.issued' && e.payload.kind === 'runtime.send') {
      const id = (e.attemptId ?? '?') as string;
      out[id] = (out[id] ?? 0) + 1;
    }
  return out;
}

/**
 * The same follow-up (attempt + subject) issued twice: a "turn start
 * unobserved" receipt must never trigger a second send (§11.1).
 */
export function repeatedSends(events: Json[]): string[] {
  const seen = new Map<string, number>();
  for (const e of events)
    if (e.type === 'command.issued' && e.payload.kind === 'runtime.send') {
      const key = `${e.attemptId ?? '?'}|${e.payload.args?.subject ?? ''}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
}
