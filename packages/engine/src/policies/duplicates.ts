import { commandId } from '../context.js';
import { external } from '../effects.js';
import type { Effect } from '../effects.js';
import type { Policy } from '../stages/types.js';

export const DUPLICATE_LABEL = 'ai-office:duplicate';

/**
 * S19 (M3 §4.8): compensate one extra copy per `duplicate-object` anomaly
 * (domain never reports the kept copy). Only copies of this workflow's own
 * commands are touched; the command ids are deterministic and already-issued
 * ones are skipped, so replays never close or delete twice. Runs while paused:
 * these are not dispatch.
 */
export const duplicatePolicy: Policy = (ctx) => {
  const event = ctx.event;
  if (
    event.type !== 'anomaly.detected' ||
    event.payload.kind !== 'duplicate-object' ||
    event.payload.commandId === undefined
  )
    return [];
  const original = event.payload.commandId;
  const issued = ctx.state.commands[original]?.issued;
  if (!issued) return [];
  const { number, commentId } = event.payload;
  const id = (...parts: (string | number)[]) =>
    commandId(ctx, 'duplicate', original, ...parts);
  const effects: Effect[] = [];
  if (commentId !== undefined && issued.kind === 'scm.comment')
    // The adapter also requires viewer authorship and the same marker; an
    // already-deleted comment counts as success.
    effects.push(
      external(id('comment', commentId), {
        kind: 'scm.deleteComment',
        args: { target: issued.args.target, commentId },
      }),
    );
  if (number !== undefined && issued.kind === 'scm.createIssue')
    effects.push(
      external(id('issue', number), {
        kind: 'scm.updateIssue',
        args: {
          issue: { repo: issued.args.repo, number },
          patch: { state: 'closed' },
        },
      }),
      external(id('issue', number, 'label'), {
        kind: 'scm.setLabels',
        args: {
          target: { type: 'issue', repo: issued.args.repo, number },
          labels: [...new Set([...issued.args.labels, DUPLICATE_LABEL])],
        },
      }),
    );
  if (number !== undefined && issued.kind === 'scm.openPR')
    effects.push(
      external(id('pr', number), {
        kind: 'scm.updatePR',
        args: {
          pr: { repo: issued.args.repo, number },
          patch: { state: 'closed' },
        },
      }),
    );
  return effects.filter(
    (e) => e.kind !== 'external' || !ctx.state.commands[e.commandId],
  );
};
