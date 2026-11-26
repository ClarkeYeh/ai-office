// Reads the budget fields of a template YAML. The `yaml` package is not
// reachable from scripts without changing the root package.json (owned by T0),
// and no workspace package exports a template parser, so this is a strict
// reader for the baseline keys only. Anything unexpected about those keys is
// an error, never a guess:
//   - top level: apiVersion, id, name, roles, defaults, stages;
//   - defaults.budget = { hardLimitMultiplier } and optional
//     defaults.workflowBudget = { tokens }, as single-line flow mappings;
//   - each `- id:` stage has one kind, at most one maxParallel (implement only,
//     required there) and at most one single-line flow-mapping budget whose keys
//     mirror contracts' BudgetSchema: tokens, maxTurns?, perItem { tokens, maxTurns? };
//   - budget, workflowBudget, hardLimitMultiplier, maxParallel, perItem,
//     tokens and maxTurns may not appear anywhere else as block keys.

/**
 * @typedef {import('./replay.mjs').Budgets} Budgets
 * @typedef {{ id: string, kind: string, maxParallel?: number }} StageInfo
 * @typedef {{ stages: StageInfo[], budgets: Budgets }} Baseline
 */

const TOP_LEVEL = new Set([
  'apiVersion',
  'id',
  'name',
  'roles',
  'defaults',
  'stages',
]);
const KINDS = new Set([
  'meeting',
  'planning',
  'implement',
  'integrate',
  'final-pr',
]);
const BASELINE_KEYS = new Set([
  'budget',
  'workflowBudget',
  'hardLimitMultiplier',
  'maxParallel',
  'perItem',
  'tokens',
  'maxTurns',
]);
const STAGE_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Single-line YAML flow mapping of numbers, words and nested mappings.
 * Duplicate keys, missing values and trailing input are errors.
 * @param {string} text
 * @returns {unknown}
 */
export function parseFlowMapping(text) {
  const tokens = text.match(/[{}:,]|[^{}:,\s]+/g) ?? [];
  let i = 0;
  const fail = () => {
    throw new Error(`Malformed flow mapping: ${text}`);
  };
  /** @returns {unknown} */
  const value = () => {
    const token = tokens[i++];
    if (token === undefined || token === '}' || token === ',' || token === ':')
      return fail();
    if (token !== '{')
      return /^-?\d+(\.\d+)?$/.test(token) ? Number(token) : token;
    /** @type {Record<string, unknown>} */
    const map = {};
    while (tokens[i] !== '}') {
      const key = tokens[i++];
      if (key === undefined || /[{}:,]/.test(key) || tokens[i++] !== ':')
        return fail();
      if (Object.hasOwn(map, key))
        throw new Error(`Duplicate key ${key} in ${text}`);
      map[key] = value();
      if (tokens[i] === ',') i++;
      else if (tokens[i] !== '}') return fail();
    }
    i++;
    return map;
  };
  if (tokens[0] !== '{') return fail();
  const result = value();
  if (i !== tokens.length) return fail();
  return result;
}

/**
 * @param {unknown} value @param {string} where
 * @param {{ required: string[], optional?: string[] }} keys
 * @returns {Record<string, unknown>}
 */
function exactKeys(value, where, { required, optional = [] }) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${where} must be a mapping`);
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(record))
    if (!required.includes(key) && !optional.includes(key))
      throw new Error(`${where}: unexpected key ${key}`);
  for (const key of required)
    if (!Object.hasOwn(record, key))
      throw new Error(`${where}: missing ${key}`);
  return record;
}

/** @param {unknown} value @param {string} where @returns {number} */
function positiveInt(value, where) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`${where} must be a positive integer`);
  return value;
}

/** @param {unknown} raw @param {string} where */
function stageBudget(raw, where) {
  const b = exactKeys(raw, where, {
    required: ['tokens'],
    optional: ['maxTurns', 'perItem'],
  });
  /** @type {import('./replay.mjs').StageBudget} */
  const budget = { tokens: positiveInt(b.tokens, `${where}.tokens`) };
  if (b.maxTurns !== undefined)
    budget.maxTurns = positiveInt(b.maxTurns, `${where}.maxTurns`);
  if (b.perItem !== undefined) {
    const item = exactKeys(b.perItem, `${where}.perItem`, {
      required: ['tokens'],
      optional: ['maxTurns'],
    });
    budget.perItem = {
      tokens: positiveInt(item.tokens, `${where}.perItem.tokens`),
      ...(item.maxTurns === undefined
        ? {}
        : {
            maxTurns: positiveInt(item.maxTurns, `${where}.perItem.maxTurns`),
          }),
    };
  }
  return budget;
}

/**
 * @param {string} yaml
 * @returns {Baseline}
 */
export function parseBaseline(yaml) {
  /** @type {{ id: string, kind?: string, maxParallel?: number, budget?: import('./replay.mjs').StageBudget, indent: number }[]} */
  const stages = [];
  /** @type {Map<string, string>} */
  const defaults = new Map();
  const sections = new Set();
  let section = '';
  yaml.split('\n').forEach((raw, index) => {
    const at = `line ${index + 1}`;
    if (raw.includes('\t')) throw new Error(`${at}: tabs are not supported`);
    const line = raw.replace(/(^|\s)#.*$/, '').trimEnd();
    if (line.trim() === '') return;
    const field = /^( *)(- +)?([A-Za-z_][\w-]*): *(.*)$/.exec(line);
    if (!field) return;
    const [, spaces = '', dash, key = '', rest = ''] = field;
    const indent = spaces.length;
    if (indent === 0 && !dash) {
      if (!TOP_LEVEL.has(key))
        throw new Error(`${at}: unexpected top-level key ${key}`);
      if (sections.has(key)) throw new Error(`${at}: duplicate ${key}`);
      sections.add(key);
      section = key;
      return;
    }
    const unexpected = () => {
      throw new Error(`${at}: unexpected ${key} here`);
    };
    if (section === 'defaults' && indent === 2 && !dash) {
      if (key !== 'budget' && key !== 'workflowBudget') {
        if (BASELINE_KEYS.has(key)) unexpected();
        return;
      }
      if (defaults.has(key))
        throw new Error(`${at}: duplicate defaults.${key}`);
      if (!rest.startsWith('{'))
        throw new Error(
          `${at}: defaults.${key} must be a single-line flow mapping`,
        );
      defaults.set(key, rest);
      return;
    }
    if (section === 'stages' && dash && key === 'id') {
      if (!STAGE_ID.test(rest))
        throw new Error(`${at}: invalid stage id ${rest}`);
      if (stages.some((s) => s.id === rest))
        throw new Error(`${at}: duplicate stage ${rest}`);
      stages.push({ id: rest, indent: indent + dash.length });
      return;
    }
    const stage = stages.at(-1);
    if (
      section === 'stages' &&
      !dash &&
      stage !== undefined &&
      indent === stage.indent
    ) {
      const where = `${at}: stage ${stage.id}`;
      if (key === 'kind') {
        if (stage.kind !== undefined)
          throw new Error(`${where}: duplicate kind`);
        if (!KINDS.has(rest)) throw new Error(`${where}: unknown kind ${rest}`);
        stage.kind = rest;
      } else if (key === 'maxParallel') {
        if (stage.maxParallel !== undefined)
          throw new Error(`${where}: duplicate maxParallel`);
        stage.maxParallel = positiveInt(
          /^\d+$/.test(rest) ? Number(rest) : rest,
          `${where} maxParallel`,
        );
      } else if (key === 'budget') {
        if (stage.budget !== undefined)
          throw new Error(`${where}: duplicate budget`);
        if (!rest.startsWith('{'))
          throw new Error(
            `${where}: budget must be a single-line flow mapping`,
          );
        stage.budget = stageBudget(parseFlowMapping(rest), `${where} budget`);
      } else if (BASELINE_KEYS.has(key)) unexpected();
      return;
    }
    if (BASELINE_KEYS.has(key)) unexpected();
  });
  if (!sections.has('stages') || stages.length === 0)
    throw new Error('Baseline has no stages');
  const defaultsBudget = defaults.get('budget');
  if (defaultsBudget === undefined)
    throw new Error('Baseline has no defaults.budget.hardLimitMultiplier');
  const multiplier = exactKeys(
    parseFlowMapping(defaultsBudget),
    'defaults.budget',
    {
      required: ['hardLimitMultiplier'],
    },
  ).hardLimitMultiplier;
  if (typeof multiplier !== 'number' || !(multiplier >= 1))
    throw new Error('defaults.budget.hardLimitMultiplier must be a number ≥ 1');
  const workflowRaw = defaults.get('workflowBudget');
  const workflow =
    workflowRaw === undefined
      ? undefined
      : positiveInt(
          exactKeys(parseFlowMapping(workflowRaw), 'defaults.workflowBudget', {
            required: ['tokens'],
          }).tokens,
          'defaults.workflowBudget.tokens',
        );
  /** @type {Record<string, import('./replay.mjs').StageBudget>} */
  const stageBudgets = {};
  /** @type {StageInfo[]} */
  const infos = [];
  for (const stage of stages) {
    if (stage.kind === undefined)
      throw new Error(`Stage ${stage.id} has no kind`);
    if ((stage.kind === 'implement') !== (stage.maxParallel !== undefined))
      throw new Error(
        `Stage ${stage.id}: maxParallel belongs to implement stages only, and is required there`,
      );
    if (stage.budget !== undefined) stageBudgets[stage.id] = stage.budget;
    infos.push({
      id: stage.id,
      kind: stage.kind,
      ...(stage.maxParallel === undefined
        ? {}
        : { maxParallel: stage.maxParallel }),
    });
  }
  return {
    stages: infos,
    budgets: {
      stages: stageBudgets,
      ...(workflow === undefined ? {} : { workflow: { tokens: workflow } }),
      hardLimitMultiplier: multiplier,
    },
  };
}

/** @param {Record<string, unknown>} map @returns {string} */
const flow = (map) =>
  `{ ${Object.entries(map)
    .map(
      ([k, v]) =>
        `${k}: ${typeof v === 'object' && v !== null ? flow(/** @type {Record<string, unknown>} */ (v)) : String(v)}`,
    )
    .join(', ')} }`;

/**
 * The template lines a recalibration would write (values only; comments are PR2's).
 * @param {Baseline} baseline
 * @param {Budgets} budgets
 */
export function renderSnippet(baseline, budgets) {
  const lines = [
    'defaults:',
    `  budget: ${flow({ hardLimitMultiplier: budgets.hardLimitMultiplier })}`,
  ];
  if (budgets.workflow !== undefined)
    lines.push(`  workflowBudget: ${flow(budgets.workflow)}`);
  lines.push('stages:');
  for (const stage of baseline.stages) {
    const budget = budgets.stages[stage.id];
    if (budget === undefined) continue;
    lines.push(`  - id: ${stage.id}`, `    budget: ${flow(budget)}`);
  }
  return lines.join('\n');
}
