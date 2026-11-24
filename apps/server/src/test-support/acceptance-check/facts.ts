/**
 * Optional GitHub (and harness) facts snapshot for the §24 checker (M5_PLAN §5
 * T10). Every value is a boolean, a count or a SHA the harness derived with
 * read-only calls; the checker never touches the network.
 */
export interface AcceptanceFacts {
  /** compare API: is each dependency's merge commit an ancestor of a dispatch base? */
  ancestry?: { baseSha: string; commit: string; isAncestor: boolean }[];
  /** §2.2.3: the `#pending` rework, per worker PR. */
  rework?: {
    pr: number;
    firstHeadHasPending: boolean;
    finalHeadHasPrNumber: boolean;
    lineByWorker: boolean;
  }[];
  /** §2.2.2 path A: the worker branch got a two-parent merge of the moved integration branch. */
  conflict?: { pr: number; twoParentMerge: boolean }[];
  /** First-parent integration-branch commits during implement, oldest first. */
  integrationFirstParent?: string[];
  /** Marker scan of the production namespace: most objects sharing one commandId. */
  markerScan?: { maxObjectsPerCommand: number };
  /** Harness `worker-list --run` observation whenever a stage gate opened. */
  workerListAtStageGates?: { gateId: string; liveAgents: number }[];
  /** activity API: `main` moved only by the owner's own merge. */
  defaultBranchMovedOnlyByOwner?: boolean;
  /** The owner's `/approve` comment on the conclusion Issue changed no state. */
  approveCommentNoStateChange?: boolean;
}

type Check = (value: unknown) => boolean;
const isBool: Check = (v) => typeof v === 'boolean';
const isCount: Check = (v) => Number.isInteger(v) && (v as number) >= 0;
const isSha: Check = (v) => typeof v === 'string' && /^[0-9a-f]{7,64}$/.test(v);
const isId: Check = (v) => typeof v === 'string' && v.length > 0;
const record =
  (shape: Record<string, Check>): Check =>
  (v) =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.entries(shape).every(([key, check]) =>
      check((v as Record<string, unknown>)[key]),
    );
const list =
  (item: Check): Check =>
  (v) =>
    Array.isArray(v) && v.every(item);

const FACTS: Record<keyof AcceptanceFacts, Check> = {
  ancestry: list(record({ baseSha: isSha, commit: isSha, isAncestor: isBool })),
  rework: list(
    record({
      pr: isCount,
      firstHeadHasPending: isBool,
      finalHeadHasPrNumber: isBool,
      lineByWorker: isBool,
    }),
  ),
  conflict: list(record({ pr: isCount, twoParentMerge: isBool })),
  integrationFirstParent: list(isSha),
  markerScan: record({ maxObjectsPerCommand: isCount }),
  workerListAtStageGates: list(record({ gateId: isId, liveAgents: isCount })),
  defaultBranchMovedOnlyByOwner: isBool,
  approveCommentNoStateChange: isBool,
};

/** Validates a facts snapshot; unknown keys are refused so typos cannot pass silently. */
export function parseFacts(value: unknown): AcceptanceFacts {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('GitHub facts must be a JSON object');
  for (const [key, item] of Object.entries(value)) {
    const check = FACTS[key as keyof AcceptanceFacts] as Check | undefined;
    if (check === undefined) throw new Error(`Unknown GitHub fact: ${key}`);
    if (!check(item)) throw new Error(`Malformed GitHub fact: ${key}`);
  }
  return value as AcceptanceFacts;
}
