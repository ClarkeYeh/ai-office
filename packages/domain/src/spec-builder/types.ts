import type { OndemandPurpose } from '@ai-office/contracts/events';
import type { AttemptPurpose } from '../state/index.js';

/** Caller-supplied values; everything else comes from `WorkflowState` (§11.5). */
export interface SpecParams {
  /** Absolute path of `<installDir>/apps/cli/dist/main.js` (Q8). */
  cliPath: string;
  /**
   * Absolute backend data directory (`AI_OFFICE_HOME`). Agents inherit Orca's
   * environment, not the backend's, so the submit command names it (§9.2).
   */
  dataDir: string;
  /** This attempt's `aio_seat_` token — the only secret a spec may contain (§9.3). */
  seatToken: string;
}

/** Which attempt the spec is for; `stageId` names the template stage. */
export type SpecRequest =
  | { purpose: 'facilitator'; stageId: string }
  | { purpose: 'participant'; stageId: string; role: string }
  | { purpose: 'planner'; stageId: string }
  | {
      purpose: 'worker';
      stageId: string;
      itemKey: string;
      /** The item attempt number (n ≥ 2 adds `-a<n>` unless reworking, §7.3). */
      attempt: number;
      /** Integration-branch commit the worktree was created from (`workitem.dispatched.baseSha`, §7.3). */
      baseSha?: string;
      /** Id of the accepted `rework-request` this attempt answers: same branch and PR (§7.3, §7.4a). */
      reworkOf?: string;
    }
  /** On-demand on-call lead (§7.5); `questionId` embeds the first queued question. */
  | { purpose: 'oncall'; stageId: string; questionId?: string }
  /** On-demand merge-queue integrator (§7.4a); `itemKey` embeds the first queued PR. */
  | { purpose: 'merge-queue'; stageId: string; itemKey?: string }
  /** Integrate-stage wrap-up integrator (§7.4b). */
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
  /** Set for on-demand role instances, as on `seat.spawned` (§7.5). */
  ondemand?: { purpose: OndemandPurpose };
  role: string;
  sections: SpecSection[];
  /** The rendered Markdown written to the spec file (byte-identical per input). */
  text: string;
}
