import type { Conclusion } from '@ai-office/contracts/events';
import type { Stage as TemplateStage } from '@ai-office/contracts/template';
import type { WorkItem, WorkflowState } from '../state/index.js';

export type TemplateStageOf<K extends TemplateStage['kind']> = Extract<
  TemplateStage,
  { kind: K }
>;

/** The conclusion later stages build on (§7.1 "已核准結論快照"). */
export interface ConclusionInput {
  body: string;
  bodyHash?: string;
}

export const renderConclusion = (conclusion: Conclusion): string =>
  [
    `Summary: ${conclusion.summary}`,
    '',
    'Decisions:',
    ...conclusion.decisions.map((d) => `- ${d.title}: ${d.rationale}`),
    '',
    'Tech decisions:',
    ...conclusion.techDecisions.map(
      (d) =>
        `- ${d.topic}: chose ${d.chosen} (options: ${d.options.join(', ')}). ${d.rationale}`,
    ),
    '',
    'Open questions:',
    ...conclusion.openQuestions.map((q) => `- ${q}`),
  ].join('\n');

/**
 * The latest approved snapshot of the meeting gate (§8.2); without one (e.g. an
 * auto-approved optional gate) the latest accepted `conclusion` submission.
 */
export const approvedConclusion = (
  state: WorkflowState,
): ConclusionInput | undefined => {
  const snapshot = Object.values(state.gates)
    .filter((gate) => gate.kind === 'stage' && gate.stageKind === 'meeting')
    .map((gate) => gate.decision?.approvedSnapshot)
    .filter((value) => value !== undefined)
    .at(-1);
  if (snapshot !== undefined)
    return { body: snapshot.body, bodyHash: snapshot.bodyHash };
  const submission = Object.values(state.submissions)
    .map((record) => record.submission)
    .filter((value) => value.kind === 'conclusion')
    .at(-1);
  return submission === undefined
    ? undefined
    : { body: renderConclusion(submission.payload) };
};

export const approvedItems = (state: WorkflowState): WorkItem[] =>
  state.workItemOrder
    .map((key) => state.workItems[key])
    .filter((item) => item !== undefined);

/**
 * Dependency order (deps first); ties keep approval order. Deps outside `items`
 * are ignored and a cycle (rejected upstream) falls back to approval order.
 */
export const dependencyOrder = (items: readonly WorkItem[]): WorkItem[] => {
  const keys = new Set(items.map((item) => item.key));
  const done = new Set<string>();
  const ordered: WorkItem[] = [];
  while (ordered.length < items.length) {
    const next =
      items.find(
        (item) =>
          !done.has(item.key) &&
          item.deps.every((dep) => !keys.has(dep) || done.has(dep)),
      ) ?? items.find((item) => !done.has(item.key));
    if (next === undefined) break;
    done.add(next.key);
    ordered.push(next);
  }
  return ordered;
};

/** `ai-office/<shortId>/<itemKey>`, `-a<n>` from the second attempt on (§7.3). */
export const workerBranchName = (
  shortId: string,
  itemKey: string,
  attempt: number,
): string =>
  `ai-office/${shortId}/${itemKey}${attempt >= 2 ? `-a${attempt}` : ''}`;
