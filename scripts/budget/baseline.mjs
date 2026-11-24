// Reads the budget fields of a template YAML. Scripts have no YAML dependency,
// so this accepts the built-in template's layout only: `- id:` stage entries
// whose `budget:` and `workflowBudget:` are single-line flow mappings.

/**
 * @typedef {import('./replay.mjs').Budgets} Budgets
 * @typedef {{ id: string, kind: string, maxParallel?: number }} StageInfo
 * @typedef {{ stages: StageInfo[], budgets: Budgets }} Baseline
 */

/**
 * @param {string} text
 * @returns {unknown}
 */
export function parseFlowMapping(text) {
  const tokens = text.match(/[{}:,]|[^{}:,\s]+/g) ?? [];
  let i = 0;
  /** @returns {unknown} */
  const value = () => {
    const token = tokens[i++];
    if (token === '{') {
      /** @type {Record<string, unknown>} */
      const map = {};
      while (tokens[i] !== '}') {
        const key = tokens[i++];
        if (key === undefined || tokens[i++] !== ':')
          throw new Error(`Malformed flow mapping: ${text}`);
        map[key] = value();
        if (tokens[i] === ',') i++;
      }
      i++;
      return map;
    }
    if (token === undefined) throw new Error(`Malformed flow mapping: ${text}`);
    return /^-?\d+(\.\d+)?$/.test(token) ? Number(token) : token;
  };
  const result = value();
  if (i !== tokens.length) throw new Error(`Malformed flow mapping: ${text}`);
  return result;
}

/** @param {string} line */
const stripComment = (line) => line.replace(/(^|\s)#.*$/, '').trimEnd();

/**
 * @param {string} yaml
 * @returns {Baseline}
 */
export function parseBaseline(yaml) {
  /** @type {(StageInfo & { budget?: any })[]} */
  const stages = [];
  /** @type {any} */
  let defaultsBudget;
  /** @type {any} */
  let workflowBudget;
  let section = '';
  for (const raw of yaml.split('\n')) {
    const line = stripComment(raw);
    if (line.trim() === '') continue;
    const top = /^(\w+):/.exec(line);
    if (top) {
      section = top[1] ?? '';
      continue;
    }
    const field = /^\s*(-\s+)?(\w+):\s*(.*)$/.exec(line);
    if (!field) continue;
    const [, dash, key, rest = ''] = field;
    if (section === 'defaults') {
      if (key === 'budget') defaultsBudget = parseFlowMapping(rest);
      if (key === 'workflowBudget') workflowBudget = parseFlowMapping(rest);
      continue;
    }
    if (section !== 'stages') continue;
    if (dash && key === 'id') {
      stages.push({ id: rest, kind: '' });
      continue;
    }
    const stage = stages.at(-1);
    if (stage === undefined) continue;
    if (key === 'kind' && stage.kind === '') stage.kind = rest;
    if (key === 'maxParallel') stage.maxParallel = Number(rest);
    if (key === 'budget') {
      if (!rest.startsWith('{'))
        throw new Error(`Stage ${stage.id}: budget must be a flow mapping`);
      stage.budget = parseFlowMapping(rest);
    }
  }
  const multiplier = defaultsBudget?.hardLimitMultiplier;
  if (typeof multiplier !== 'number')
    throw new Error('Baseline has no defaults.budget.hardLimitMultiplier');
  /** @type {Record<string, any>} */
  const stageBudgets = {};
  for (const stage of stages)
    if (stage.budget !== undefined) stageBudgets[stage.id] = stage.budget;
  return {
    stages: stages.map((stage) => {
      const info = { ...stage };
      delete info.budget;
      return info;
    }),
    budgets: {
      stages: stageBudgets,
      ...(typeof workflowBudget?.tokens === 'number'
        ? { workflow: { tokens: workflowBudget.tokens } }
        : {}),
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
