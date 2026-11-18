import type { ReadModel } from '@ai-office/projection';
import type { EventStore } from '../../ports/stores.js';
import type { RepoScmRef } from '../../ports/refs.js';
import type { ScmPort } from '../../ports/scm.js';
import type { Logger } from '../../ports/services.js';
import { toErrorInfo } from '../commands/errors.js';
import { hash } from '../use-cases/support.js';

export type GateBodyDeps = {
  scm?: Pick<ScmPort, 'getIssue'>;
  logger?: Logger;
  /** `githubBody` is omitted when the issue read takes longer than this. */
  scmTimeoutMs?: number;
};

type GateView = ReadModel['gates'][number];

const MARKER = /\n*<!-- ai-office:cmd=.+? -->/g;
const PAGE = 200;

/** Last issued body of the conclusion issue (with marker), its repo and number. */
function conclusionIssue(events: EventStore, gate: GateView) {
  // Meeting gates and their issue command share `<workflow>/<stage>/<attempt>/`.
  if (!gate.gateId.endsWith('/gate')) return undefined;
  const commandId = `${gate.gateId.slice(0, -'/gate'.length)}/issue`;
  let found: { repo: RepoScmRef; body: string; number?: number } | undefined;
  for (let afterSeq = 0; ;) {
    const page = events.read({
      workflowId: gate.workflowId,
      afterSeq,
      limit: PAGE,
    });
    for (const event of page) {
      if (event.type === 'command.issued') {
        const p = event.payload;
        if (p.kind === 'scm.createIssue' && p.commandId === commandId)
          found = { repo: p.args.repo, body: p.args.body };
        else if (
          p.kind === 'scm.updateIssue' &&
          found?.number !== undefined &&
          p.args.issue.number === found.number &&
          p.args.patch.body !== undefined
        )
          found.body = p.args.patch.body;
      } else if (event.type === 'command.succeeded') {
        const p = event.payload;
        if (found && p.kind === 'scm.createIssue' && p.commandId === commandId)
          found.number = p.result.issue;
      }
    }
    if (page.length < PAGE) return found;
    afterSeq = page.at(-1)!.seq;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SCM read timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * G3b: request-time `githubBody` (live issue) and `renderedBody` (event store, marker
 * stripped) for the conclusion diff view. Either is omitted when it cannot be trusted.
 */
export async function withGateBodies(
  gate: GateView,
  events: EventStore,
  { scm, logger, scmTimeoutMs = 2000 }: GateBodyDeps,
): Promise<GateView> {
  const conclusion = gate.conclusion;
  if (gate.content.type !== 'conclusion' || !conclusion) return gate;
  const issue = conclusionIssue(events, gate);
  if (!issue) return gate;
  if ((await hash(issue.body)) === conclusion.renderedHash)
    conclusion.renderedBody = issue.body.replace(MARKER, '');
  else
    logger?.warn(
      { gateId: gate.gateId },
      'conclusion issue body does not match renderedHash; renderedBody omitted',
    );
  if (scm && issue.number !== undefined)
    try {
      conclusion.githubBody = (
        await withTimeout(
          scm.getIssue({ repo: issue.repo, number: issue.number }),
          scmTimeoutMs,
        )
      ).body;
    } catch (error) {
      logger?.warn(
        { gateId: gate.gateId, error: toErrorInfo(error) },
        'conclusion issue unavailable; githubBody omitted',
      );
    }
  return gate;
}
