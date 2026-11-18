import type { ReadModel } from '@ai-office/projection';
import type { Conclusion } from '@ai-office/contracts/events';
import { lineDiff, type LineDiff } from './diff.js';
import type { GateView } from './gateHeader.js';

export type { Conclusion };
export type TechDecision = Conclusion['techDecisions'][number];

/** The command marker the engine appends to issue bodies (`ai-office:cmd=<id>`). */
const MARKER = /\n*<!-- ai-office:cmd=.+? -->/g;
const SECTIONS = [
  'summary',
  'decisions',
  'techDecisions',
  'openQuestions',
] as const;

/** `githubBody` is raw (hash-consistent); strip the command marker before showing or diffing. */
export function stripMarker(body: string): string {
  return body.replace(MARKER, '');
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);
const isRecordArray = <K extends string>(
  value: unknown,
  keys: readonly K[],
  arrays: readonly K[] = [],
): value is Record<K, unknown>[] =>
  Array.isArray(value) &&
  value.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      keys.every((key) =>
        arrays.includes(key)
          ? isStringArray((entry as Record<string, unknown>)[key])
          : isString((entry as Record<string, unknown>)[key]),
      ),
  );

/**
 * Parse the section markers the engine renders (`<!-- ai-office:<key>:start -->`,
 * a heading, JSON, `<!-- ai-office:<key>:end -->`). Null when any section is
 * missing or malformed (§8.2 step 4: the full text is then authoritative).
 */
export function parseConclusionBody(body: string): Conclusion | null {
  const values: Record<string, unknown> = {};
  for (const key of SECTIONS) {
    const match = new RegExp(
      `<!-- ai-office:${key}:start -->\\n(?:## [^\\n]*\\n)?([\\s\\S]*?)\\n<!-- ai-office:${key}:end -->`,
    ).exec(body.replace(/\r\n?/g, '\n'));
    if (!match) return null;
    try {
      values[key] = JSON.parse(match[1]!);
    } catch {
      return null;
    }
  }
  const { summary, decisions, techDecisions, openQuestions } = values;
  if (
    !isString(summary) ||
    !isRecordArray(decisions, ['title', 'rationale']) ||
    !isRecordArray(
      techDecisions,
      ['topic', 'options', 'chosen', 'rationale'],
      ['options'],
    ) ||
    !isStringArray(openQuestions)
  )
    return null;
  return {
    summary,
    decisions: decisions.map(({ title, rationale }) => ({
      title: title as string,
      rationale: rationale as string,
    })),
    techDecisions: techDecisions.map(
      ({ topic, options, chosen, rationale }) => ({
        topic: topic as string,
        options: options as string[],
        chosen: chosen as string,
        rationale: rationale as string,
      }),
    ),
    openQuestions,
  };
}

export type ConclusionDocument =
  | { kind: 'structured'; conclusion: Conclusion }
  | { kind: 'raw'; text: string }
  | { kind: 'unavailable' };
export type ConclusionDiff =
  ({ kind: 'lines' } & LineDiff) | { kind: 'unavailable' };
export interface RoundStatement {
  role: string;
  position: string;
}
export interface ConclusionViewModel {
  github: ConclusionDocument;
  original: ConclusionDocument;
  diff: ConclusionDiff;
  changedOnGithub: boolean;
  /** Where revise starts: GitHub's structured content, else the original. */
  editBase: { source: 'github' | 'original'; conclusion: Conclusion } | null;
  issue: { number: number; url: string } | null;
  round: number | null;
  statements: RoundStatement[];
}

function conclusionIssue(
  gate: GateView,
  model: ReadModel | null,
): ConclusionViewModel['issue'] {
  // G3 (S12): the gate has no link; look the conclusion issue up in artifacts[].
  const issues = (model?.artifacts ?? []).filter(
    (a) =>
      a.kind === 'issue' &&
      a.number !== undefined &&
      a.url !== undefined &&
      (a.purpose === 'conclusion' || a.stageId === gate.stageId) &&
      (a.stageId === undefined || a.stageId === gate.stageId),
  );
  const issue = issues.at(-1);
  return issue ? { number: issue.number!, url: issue.url! } : null;
}

function lastRound(gate: GateView, model: ReadModel | null) {
  const meeting = model?.stages.find(
    (s) => s.stageId === gate.stageId,
  )?.meeting;
  if (!meeting || meeting.statements.length === 0)
    return { round: null, statements: [] };
  const round = Math.max(...meeting.statements.map((s) => s.round));
  return {
    round,
    statements: meeting.statements
      .filter((s) => s.round === round)
      .map(({ role, position }) => ({ role, position })),
  };
}

/**
 * Conclusion gate (I-12): GitHub current version, AI Office original and their diff.
 * `githubBody` or `renderedBody` may be absent (SCM down, hash mismatch, revised gate);
 * the page must still render and approval stays possible.
 */
export function conclusionViewModel(
  gate: GateView,
  model: ReadModel | null,
): ConclusionViewModel {
  const view = gate.conclusion;
  const githubText =
    view?.githubBody === undefined ? undefined : stripMarker(view.githubBody);
  const githubParsed =
    githubText === undefined ? null : parseConclusionBody(githubText);
  const github: ConclusionDocument =
    githubText === undefined
      ? { kind: 'unavailable' }
      : githubParsed
        ? { kind: 'structured', conclusion: githubParsed }
        : { kind: 'raw', text: githubText };
  const original: ConclusionDocument = view?.original
    ? { kind: 'structured', conclusion: view.original }
    : view?.renderedBody !== undefined
      ? { kind: 'raw', text: view.renderedBody }
      : { kind: 'unavailable' };
  const diff: ConclusionDiff =
    githubText !== undefined && view?.renderedBody !== undefined
      ? { kind: 'lines', ...lineDiff(view.renderedBody, githubText) }
      : { kind: 'unavailable' };
  return {
    github,
    original,
    diff,
    changedOnGithub: view?.changedOnGithub ?? false,
    editBase: githubParsed
      ? { source: 'github', conclusion: githubParsed }
      : view?.original
        ? { source: 'original', conclusion: view.original }
        : null,
    issue: conclusionIssue(gate, model),
    ...lastRound(gate, model),
  };
}

// Revise editor ---------------------------------------------------------------

export interface TechDraft {
  topic: string;
  options: string;
  chosen: string;
  rationale: string;
}
export interface ConclusionDraft {
  summary: string;
  decisions: string;
  openQuestions: string;
  techDecisions: TechDraft[];
}
const DECISION_SEPARATOR = '｜';
const OPTION_SEPARATOR = /[、,，]/;
const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export function draftFromConclusion(conclusion: Conclusion): ConclusionDraft {
  return {
    summary: conclusion.summary,
    decisions: conclusion.decisions
      .map((d) =>
        d.rationale ? `${d.title}${DECISION_SEPARATOR}${d.rationale}` : d.title,
      )
      .join('\n'),
    openQuestions: conclusion.openQuestions.join('\n'),
    techDecisions: conclusion.techDecisions.map((d) => ({
      topic: d.topic,
      options: d.options.join('、'),
      chosen: d.chosen,
      rationale: d.rationale,
    })),
  };
}

export function conclusionFromDraft(draft: ConclusionDraft): Conclusion {
  return {
    summary: draft.summary.trim(),
    decisions: lines(draft.decisions).map((line) => {
      const at = line.indexOf(DECISION_SEPARATOR);
      return at < 0
        ? { title: line, rationale: '' }
        : {
            title: line.slice(0, at).trim(),
            rationale: line.slice(at + 1).trim(),
          };
    }),
    techDecisions: draft.techDecisions
      .filter((d) => d.topic.trim() || d.chosen.trim())
      .map((d) => ({
        topic: d.topic.trim(),
        options: d.options
          .split(OPTION_SEPARATOR)
          .map((option) => option.trim())
          .filter(Boolean),
        chosen: d.chosen.trim(),
        rationale: d.rationale.trim(),
      })),
    openQuestions: lines(draft.openQuestions),
  };
}

export const emptyTechDraft = (): TechDraft => ({
  topic: '',
  options: '',
  chosen: '',
  rationale: '',
});
