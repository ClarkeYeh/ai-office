import { releaseAttempt, stopAttempt } from '../agents.js';
import { commandId, metaFor } from '../context.js';
import { external, internal } from '../effects.js';
import type { Effect } from '../effects.js';
import type { Policy } from '../stages/types.js';

/** Durable cancel drain: late spawn results join the drain; never dispose a workspace. */
export const cancelPolicy: Policy = (ctx) => {
  const workflow = ctx.state.workflow;
  if (!workflow?.cancelRequested || workflow.status !== 'running') return [];
  if (ctx.event.type === 'command.issued') return [];
  const effects: Effect[] = Object.values(ctx.state.timers).map((t) => ({
    kind: 'cancelTimer',
    id: t.id,
    reason: 'cancelled',
  }));
  if (effects.length) return effects;
  let waiting = false;
  for (const attempt of Object.values(ctx.state.attempts)) {
    if (attempt.released) continue;
    if (!attempt.agentRef) {
      if (ctx.state.commands[attempt.spawnCommandId]?.status !== 'failed')
        waiting = true;
      continue;
    }
    const stopId = commandId(ctx, 'stop', attempt.attemptId, 'cancel');
    const releaseId = commandId(ctx, 'release', attempt.attemptId, 'cancel');
    if (
      attempt.state !== 'exited' &&
      ctx.state.commands[stopId]?.status !== 'succeeded'
    ) {
      waiting = true;
      if (!ctx.state.commands[stopId])
        effects.push(...stopAttempt(ctx, attempt, 'cancel'));
      continue;
    }
    waiting = true;
    if (!ctx.state.commands[releaseId])
      effects.push(...releaseAttempt(ctx, attempt, false, 'cancel'));
  }
  // A materialized spawn may still be in the outbox before seat.spawned arrives.
  if (
    Object.values(ctx.state.commands).some(
      (c) => c.issued.kind === 'runtime.spawnAgent' && c.status === 'issued',
    )
  )
    waiting = true;
  if (waiting) return effects;
  for (const gate of Object.values(ctx.state.gates))
    if (gate.status === 'open') {
      waiting = true;
      effects.push(
        internal({
          type: 'CloseGate',
          meta: metaFor(ctx),
          gateId: gate.gateId,
          reason: 'cancelled',
        }),
      );
    }
  if (waiting) return effects;
  const targets = new Map<number, 'issue' | 'pr'>();
  for (const artifact of Object.values(ctx.state.artifacts))
    if (artifact.kind === 'issue' || artifact.kind === 'pr')
      targets.set(artifact.number, artifact.kind);
  for (const item of Object.values(ctx.state.workItems)) {
    if (item.issue) targets.set(item.issue, 'issue');
    if (item.pr) targets.set(item.pr, 'pr');
  }
  if (workflow.finalPr) targets.set(workflow.finalPr, 'pr');
  // Include objects whose command succeeded just before cancellation, before artifact recording.
  for (const c of Object.values(ctx.state.commands)) {
    const r = c.result;
    if (r?.kind === 'scm.createIssue' && r.result && 'issue' in r.result)
      targets.set(r.result.issue, 'issue');
    if (r?.kind === 'scm.openPR' && r.result && 'pr' in r.result)
      targets.set(r.result.pr, 'pr');
    if (
      c.status === 'issued' &&
      ['scm.createIssue', 'scm.openPR'].includes(c.issued.kind)
    )
      waiting = true;
  }
  for (const [number, type] of targets) {
    const id = commandId(ctx, 'cancel-label', type, number);
    if (ctx.state.commands[id]?.status === 'succeeded') continue;
    waiting = true;
    if (ctx.state.commands[id]) continue;
    const labels = new Set(ctx.state.issueDrift[number]?.labels ?? []);
    for (const c of Object.values(ctx.state.commands)) {
      if (
        c.issued.kind === 'scm.setLabels' &&
        c.issued.args.target.number === number
      )
        c.issued.args.labels.forEach((l) => labels.add(l));
      if (
        c.issued.kind === 'scm.createIssue' &&
        c.result?.kind === 'scm.createIssue' &&
        c.result.result &&
        'issue' in c.result.result &&
        c.result.result.issue === number
      )
        c.issued.args.labels.forEach((l) => labels.add(l));
    }
    labels.add('ai-office:cancelled');
    effects.push(
      external(id, {
        kind: 'scm.setLabels',
        args: {
          target: { repo: workflow.repo.github, number, type },
          labels: [...labels],
        },
      }),
    );
  }
  if (!waiting && effects.length === 0)
    effects.push(internal({ type: 'MarkCancelled', meta: metaFor(ctx) }));
  return effects;
};
