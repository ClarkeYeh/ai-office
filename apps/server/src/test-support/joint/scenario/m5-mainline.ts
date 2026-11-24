/**
 * M5-T8 `m5-mainline` (M5_PLAN §2.2): the real-scale joint-run scenario as
 * data. The same text drives T9 (fake world), T11 (rehearsal), T11b (real
 * agents, scm-gitremote) and T12 (production). Five items on the built-in
 * `feature-to-pr` template: `core` first; `mul`, `sub` and `name` depend on
 * `core` (plan v2 refinement 1); `docs` depends on `mul` and `sub`.
 *
 * Forced behaviours come from structure, not from reviewer-only hints:
 * - on-call answer: `core` asks one yes/no question before writing;
 * - escalation: `name` asks for the code name, which the requirement reserves
 *   for the owner;
 * - conflict: `mul` and `sub` replace the same line from the same base;
 * - rework: `docs` must end with its own PR number, which exists only after
 *   the worker pushes, so the first submission carries the `#pending` nonce
 *   (§28 item 4, N9).
 */
import type { WorkItemDraft } from '@ai-office/contracts/events';
// The nonce helpers live with the M2 implement scenario (test-support/orca),
// which joint may import; orca never imports joint (M5_PLAN §1.3).
export {
  PENDING_LINE,
  reviewedLine,
  lastLine,
  nonceState,
} from '../../orca/t17/review-nonce.js';

export const SCENARIO_ID = 'm5-mainline';
export const TEMPLATE_ID = 'feature-to-pr';

export const ITEM_KEYS = ['core', 'mul', 'sub', 'name', 'docs'] as const;
export type ItemKey = (typeof ITEM_KEYS)[number];

/** Who implements what and in which order (the §2.2.1 table). */
export const SHAPE: Record<
  ItemKey,
  { agent: 'claude-code' | 'codex'; deps: readonly ItemKey[] }
> = {
  core: { agent: 'claude-code', deps: [] },
  mul: { agent: 'codex', deps: ['core'] },
  sub: { agent: 'claude-code', deps: ['core'] },
  name: { agent: 'codex', deps: ['core'] },
  docs: { agent: 'codex', deps: ['mul', 'sub'] },
};

/** The two items whose PRs conflict; the first `scm.mergePR` of either is K. */
export const CONFLICT_KEYS = ['mul', 'sub'] as const;
/** The item whose escalated question the harness holds (§2.2.4). */
export const ESCALATION_KEY = 'name';
/** The item that cannot pass its first review (§2.2.3). */
export const REWORK_KEY = 'docs';
/** The item whose on-call question is answered without a human. */
export const ONCALL_KEY = 'core';

/** The owner's answer to the code-name escalation; recorded only as a boolean. */
export const CODE_NAME = 'Birch';

/** Per-run directory tag: the UTC minute, so merged runs never collide. */
export function mainlineTag(now: Date): string {
  return now.toISOString().slice(0, 16).replace(/[-T:]/g, '');
}

const assertTag = (tag: string) => {
  if (!/^\d{12}$/.test(tag)) throw new Error('Invalid m5-mainline tag');
};

/**
 * The requirement. Multi-line; the first line is the title (FX-TITLE). It
 * reserves the code name for the owner and fences the run into `m5/<tag>/`.
 */
export function requirement(tag: string): string {
  assertTag(tag);
  const dir = `m5/${tag}`;
  return [
    `M5 mainline: a small calculator module under ${dir}/`,
    '',
    `Create a small ES module calculator with node:test tests, a README and a product code-name file, all under ${dir}/:`,
    `- ${dir}/calc.mjs exports add, mul and sub; the operations other than add live between the marker lines \`// ops:begin\` and \`// ops:end\`.`,
    `- ${dir}/calc.test.mjs tests every exported operation with node:test, and \`node --test ${dir}\` passes.`,
    `- ${dir}/README.md lists every operation.`,
    `- ${dir}/NAME.md holds the product code name.`,
    '',
    'The product code name is a decision reserved for the owner; agents must not choose it.',
    `Do not modify any file outside ${dir}/, and do not add or modify anything under .github/.`,
  ].join('\n');
}

const engineer = (
  key: ItemKey,
  title: string,
  body: string[],
  acceptance: string[],
): WorkItemDraft => ({
  key,
  title,
  body: body.join(' '),
  acceptance,
  role: 'engineer',
  agent: SHAPE[key].agent,
  deps: [...SHAPE[key].deps],
});

/**
 * The approved task split. The harness revises any other proposal to this
 * list at the task-split gate (§2.2.4); every field is editable in the
 * built-in template, including new keys (N10).
 */
export function mainlineItems(tag: string): WorkItemDraft[] {
  assertTag(tag);
  const dir = `m5/${tag}`;
  const passes = `\`node --test ${dir}\` passes`;
  const stayInside = `Change no file outside ${dir}/.`;
  const replaceOp = (fn: string, op: string) => [
    `In ${dir}/calc.mjs, replace the single line \`// (no ops yet)\` between \`// ops:begin\` and \`// ops:end\` with \`export function ${fn}(a, b) { return a ${op} b; }\`.`,
    `Append node:test tests for ${fn} at the end of ${dir}/calc.test.mjs.`,
    'Keep add and its tests unchanged.',
    stayInside,
  ];
  return [
    engineer(
      'core',
      `Create the calculator core in ${dir}/`,
      [
        `Create ${dir}/calc.mjs as an ES module that exports \`add(a, b)\`, followed by exactly these three lines at the end of the file: \`// ops:begin\`, \`// (no ops yet)\`, \`// ops:end\`.`,
        `Create ${dir}/calc.test.mjs with node:test tests for add.`,
        'Before writing any file, ask your on-call lead exactly one question using the AI Office question mechanism from your instructions: "Should add() accept numeric strings such as \\"2\\"? Answer yes or no." Follow the answer.',
        stayInside,
      ],
      [
        `${dir}/calc.mjs exports add and ends with the lines \`// ops:begin\`, \`// (no ops yet)\`, \`// ops:end\` in that order`,
        `${dir}/calc.test.mjs tests add and ${passes}`,
      ],
    ),
    engineer('mul', `Add mul to ${dir}/calc.mjs`, replaceOp('mul', '*'), [
      `${dir}/calc.mjs exports mul between \`// ops:begin\` and \`// ops:end\`, and add is unchanged`,
      `${dir}/calc.test.mjs tests mul and ${passes}`,
    ]),
    engineer('sub', `Add sub to ${dir}/calc.mjs`, replaceOp('sub', '-'), [
      `${dir}/calc.mjs exports sub between \`// ops:begin\` and \`// ops:end\`, and add is unchanged`,
      `${dir}/calc.test.mjs tests sub and ${passes}`,
    ]),
    engineer(
      'name',
      `Add the product code name in ${dir}/NAME.md`,
      [
        `Create ${dir}/NAME.md containing exactly one line: the product code name.`,
        'The code name is a decision reserved for the owner: do not choose, invent or guess one.',
        'Before writing the file, ask your on-call lead which code name to use, using the AI Office question mechanism from your instructions, and write exactly the name you are given.',
        'Change no other file.',
      ],
      [
        `${dir}/NAME.md contains exactly one line: the code name given in the answer to your question`,
      ],
    ),
    engineer(
      'docs',
      `Document the operations in ${dir}/README.md`,
      [
        `Create ${dir}/README.md: a title line, then one bullet per operation exported by ${dir}/calc.mjs (add, mul and sub) with a one-line description.`,
        "The last line of README.md must be `Reviewed in PR #<number>`, where <number> is the number of this work item's pull request.",
        'AI Office opens that pull request only after you push, so the number does not exist yet: on your first submission write exactly `Reviewed in PR #pending` as the last line. Do not guess the number and do not look it up.',
        'Only the worker of this item writes that line. A merge-queue reviewer does not edit it and instead sends the item back with rework-request stating the correct number.',
        stayInside,
      ],
      [
        `${dir}/README.md lists add, mul and sub`,
        "The last line of README.md is `Reviewed in PR #<number of this work item's pull request>`; on the first submission it is exactly `Reviewed in PR #pending`, never a guessed number",
        "That line is written only by this work item's worker; a merge-queue reviewer does not edit it and reports the correct number with rework-request",
      ],
    ),
  ];
}

/**
 * Every text a worker can see: the requirement and each item's title, body
 * and acceptance (the merge-queue reviewer sees the same item text).
 */
export function workerVisibleText(tag: string): string[] {
  return [
    requirement(tag),
    ...mainlineItems(tag).flatMap((i) => [i.title, i.body, ...i.acceptance]),
  ];
}

/**
 * Phrases that only make sense to a reviewer told to fake a rework (the M2
 * `implement-scenario` antipattern, §28 item 4). None may reach a worker.
 */
export const REVIEWER_ONLY_PHRASES: readonly RegExp[] = [
  /first review/i,
  /must request rework/i,
  /request rework on/i,
  /always (send|request) .*rework/i,
  /reject the first/i,
];

const sameList = (a: unknown, b: readonly string[]) =>
  Array.isArray(a) &&
  a.length === b.length &&
  [...a].map(String).sort().join('\0') === [...b].sort().join('\0');

/**
 * A proposed split already equals the approved one, so the harness can
 * approve instead of revising: five items with the §2.2.1 keys, deps and
 * agents, and the scenario's own title, body, acceptance and role (the forced
 * behaviours live in that text, so a paraphrase is revised too).
 */
export function splitMatches(items: unknown, tag: string): boolean {
  if (!Array.isArray(items) || items.length !== ITEM_KEYS.length) return false;
  const expected = new Map(mainlineItems(tag).map((i) => [i.key, i]));
  return items.every((raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return false;
    const item = raw as Record<string, unknown>;
    const want = expected.get(String(item.key));
    if (!want) return false;
    expected.delete(want.key);
    return (
      item.agent === want.agent &&
      sameList(item.deps, want.deps) &&
      item.role === want.role &&
      item.title === want.title &&
      item.body === want.body &&
      sameList(item.acceptance, want.acceptance)
    );
  });
}

/** The `revise` edits for the task-split gate (only `WorkItemDraft` fields). */
export const reviseEdits = (tag: string) => ({
  type: 'work-items' as const,
  items: mainlineItems(tag),
});

/**
 * K and K′ (§2.3.2): exactly one backend kill per run. K is the first
 * `scm.mergePR` issued for a `mul` or `sub` PR; K′ is the `docs` spawn, used
 * only when K was never seen.
 */
export const RESTART_TRIGGERS = {
  primary: { itemKeys: CONFLICT_KEYS, commandKind: 'scm.mergePR' },
  fallback: { itemKeys: ['docs'], commandKind: 'runtime.spawnAgent' },
} as const;

/**
 * §2.2.2 (N8): ways the forced conflict may be handled, read from GitHub
 * facts and events. All count; `rework` and `exception-gate` are variance.
 */
export const CONFLICT_PATHS = {
  'integrator-merge':
    'second PR branch gains a two-parent merge commit whose second parent is the integration head after the first merge; then the backend merges it',
  rework:
    'workitem.rework_requested; the worker pushes a commit containing the new integration head on the same branch; then it merges',
  'exception-gate':
    "command.failed{conflict} or decision-request{unresolvable-conflict} → exception gate → the harness picks 'retry' once",
} as const;
export type ConflictPath = keyof typeof CONFLICT_PATHS;
