export {
  formatWaited,
  gateHeaderViewModel,
  quietState,
  rerunsLeft,
} from './gateHeader.js';
export type {
  GateFact,
  GateHeaderArgs,
  GateHeaderViewModel,
  GateQuiet,
  GateStatus,
  GateView,
} from './gateHeader.js';
export {
  conclusionFromDraft,
  conclusionViewModel,
  draftFromConclusion,
  emptyTechDraft,
  parseConclusionBody,
  stripMarker,
} from './conclusion.js';
export type {
  Conclusion,
  ConclusionDiff,
  ConclusionDocument,
  ConclusionDraft,
  ConclusionViewModel,
  RoundStatement,
  TechDecision,
  TechDraft,
} from './conclusion.js';
export { DIFF_MAX_LINES, lineDiff } from './diff.js';
export type { DiffKind, DiffLine, LineDiff } from './diff.js';
export type { ReadModel } from '@ai-office/projection';
export type { QuestionView } from '@ai-office/contracts/api';
