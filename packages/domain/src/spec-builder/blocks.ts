import type { AgentSubmission, SubmissionKind } from '../state/index.js';
import { bullets, fenced, shellQuote } from './markdown.js';
import type { SpecParams, SpecSection } from './types.js';

/** §6.1: commands no dispatched agent may run; detected by redactor policy hits. */
export const FORBIDDEN_COMMANDS = [
  'orca orchestration worker-start',
  'orca orchestration dispatch',
  'orca orchestration run-create',
  'orca orchestration run-use',
  'orca orchestration worker-stop',
  'orca orchestration worker-release',
  'orca worktree create --agent',
  'orca agent launch',
  'orca terminal create',
  'gh pr merge',
  'gh issue comment',
  'gh label',
] as const;

export const forbiddenSection = (
  defaultBranch: string,
  extra: readonly string[] = [],
): SpecSection => ({
  id: 'forbidden',
  title: 'Forbidden commands',
  lines: [
    'Never run any of these commands, directly or through a script or alias. AI Office detects them, stops this attempt and pauses the workflow:',
    '',
    ...bullets(FORBIDDEN_COMMANDS.map((command) => `\`${command}\``)),
    `- \`git push\` to the default branch \`${defaultBranch}\`, including force pushes and pushes through another remote or refspec`,
    ...bullets(extra),
    '',
    'AI Office alone starts, stops and releases agents, merges pull requests and writes to GitHub Issues. Do not start helper workers or sub-agents. The only Orca commands you may run are the reporting commands from your Orca dispatch preamble (`worker_done`, and `ask` where this spec allows questions).',
  ],
});

const SUBMIT_EOF = 'AIO_JSON';

/** The exact CLI invocation (§9.2): absolute path, payload on stdin, no files in the worktree. */
export const submitCommand = (
  params: SpecParams,
  kind: SubmissionKind | '<kind>',
  payload: string,
): string[] =>
  fenced(
    [
      `node ${shellQuote(params.cliPath)} submit ${kind} --seat-token ${shellQuote(params.seatToken)} - <<'${SUBMIT_EOF}'`,
      payload,
      SUBMIT_EOF,
    ].join('\n'),
    'sh',
  );

export const submissionSection = (
  params: SpecParams,
  examples: readonly AgentSubmission[],
  notes: readonly string[] = [],
): SpecSection => ({
  id: 'submission',
  title: 'Submitting results',
  lines: [
    'Submit structured results with the AI Office CLI at its absolute path (do not rely on `PATH`). Pass the JSON payload on standard input through a quoted heredoc exactly as shown; do not write payload files into the worktree.',
    '',
    ...submitCommand(params, '<kind>', '<payload JSON>'),
    '',
    ...bullets([
      'The seat token identifies this attempt. Use it only in this command; never write it into files, commits, issues, pull requests or messages.',
      'Exit 0: accepted; stdout is `{"status":"accepted","submissionId":…}`.',
      'Exit 2: schema error; stdout is `{"issues":[{"path":…,"code":…,"message":…}]}`. Fix every listed issue and submit again.',
      'Exit 3: identity or state error (for example the gate is already open or this kind is not allowed now). Unless a note below says otherwise, do not retry the same submission; quote the error in your `worker_done` report.',
      'Exit 4: the AI Office backend is unreachable. Wait 30 seconds and run the same command again, at most 5 times.',
      'Submitting the same kind again before the stage gate opens replaces your earlier submission.',
      ...notes,
    ]),
    ...examples.flatMap((example) => [
      '',
      `Example \`${example.kind}\` payload:`,
      '',
      ...fenced(JSON.stringify(example.payload, null, 2), 'json'),
    ]),
  ],
});

/** Shared side-effect rule for read-only roles (meeting, planning, on-call; §7.1). */
export const READ_ONLY_RULES = [
  'Read files only. Do not create, modify or delete any file in the worktree.',
  'Do not commit, push, or run `gh` in any form.',
  'Do not run `orca orchestration` mutation commands; only the reporting commands from your Orca preamble are allowed.',
];

export const SUBMIT_THEN_DONE =
  'Completion protocol: submit first, then report `worker_done`. Never report `worker_done` for a turn before its submission has been accepted (exit 0).';

export const MISSED_SUBMISSION =
  'If AI Office does not receive a required submission in time it sends one reminder and then waits 5 minutes before escalating the stage to a human.';
