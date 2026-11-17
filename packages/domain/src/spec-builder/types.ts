import type { AttemptPurpose } from '../state/index.js';

/** Caller-supplied values; everything else comes from `WorkflowState` (§11.5). */
export interface SpecParams {
  /** Absolute path of `<installDir>/apps/cli/dist/main.js` (Q8). */
  cliPath: string;
  /** This attempt's `aio_seat_` token — the only secret a spec may contain (§9.3). */
  seatToken: string;
}

/** Which attempt the spec is for; `stageId` names the template stage. */
export type SpecRequest =
  | { purpose: 'facilitator'; stageId: string }
  | { purpose: 'participant'; stageId: string; role: string }
  | { purpose: 'planner'; stageId: string }
  /** `attempt` is the item attempt number (n ≥ 2 adds `-a<n>`, §7.3). */
  | { purpose: 'worker'; stageId: string; itemKey: string; attempt: number }
  /** `questionId` embeds the first queued question in the spec (§7.5). */
  | { purpose: 'oncall'; stageId: string; questionId?: string }
  | { purpose: 'integrator'; stageId: string };

export type SpecSectionId =
  | 'goal'
  | 'role'
  | 'inputs'
  | 'workspace'
  | 'forbidden'
  | 'submission'
  | 'questions'
  | 'completion';

/** Structured blocks, so wording can change after M2 trials without new plumbing. */
export interface SpecSection {
  id: SpecSectionId;
  title: string;
  lines: string[];
}

export interface AgentSpec {
  purpose: AttemptPurpose;
  role: string;
  sections: SpecSection[];
  /** The rendered Markdown written to the spec file (byte-identical per input). */
  text: string;
}
