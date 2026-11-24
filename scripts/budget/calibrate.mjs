// Budget recalibration (M5 §4.3, review B6). Reads exported event JSON and a
// baseline template, recommends budgets (only up), and checks the criteria:
//   1. replaying each run with enforcement on and the new values gives 0 budget.*;
//   2. the workflow budget is at least 1.5× each run's usage;
//   3. crossing each threshold, then its hard limit, raises exactly one alert each.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseBaseline, renderSnippet } from './baseline.mjs';
import { replayRun, runsFromExport, thresholdMechanism } from './replay.mjs';

/**
 * @typedef {import('./replay.mjs').Budgets} Budgets
 * @typedef {import('./replay.mjs').StageBudget} StageBudget
 * @typedef {import('./replay.mjs').Run} Run
 * @typedef {import('./baseline.mjs').Baseline} Baseline
 * @typedef {{ tokens: number[], turns: number[] }} Series
 * @typedef {{ runs: number, stages: Record<string, Series>, perItem: Record<string, Series>, itemShare: Record<string, Series>, workflow: number[] }} Samples
 * @typedef {{ level: string, metric: 'tokens' | 'turns', n: number, p90?: number, old: number, computed?: number, value: number, headroom?: number, loose: boolean }} Row
 */

export const FACTOR = 1.5;
export const STEP = { tokens: 50_000, turns: 10 };
export const LOOSE = 10;
export const MIN_WORKFLOW_HEADROOM = 1.5;

/** Nearest-rank p90; undefined for an empty sample. @param {number[]} values */
export function p90(values) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1];
}

/** @param {number} value @param {number} step */
export const roundUp = (value, step) => Math.ceil(value / step) * step;

/** @returns {Series} */
const series = () => ({ tokens: [], turns: [] });

/**
 * Aggregates usage per stage attempt, per item attempt, per item (with the
 * implement stage's merge-queue/on-call usage shared evenly) and per run.
 * Turn samples exist only where the export recorded turns.
 * @param {Run[]} runs
 * @returns {Samples}
 */
export function samplesFromRuns(runs) {
  /** @type {Samples} */
  const samples = {
    runs: runs.length,
    stages: {},
    perItem: {},
    itemShare: {},
    workflow: [],
  };
  /** @param {Record<string, Series>} target @param {string} key */
  const at = (target, key) => (target[key] ??= series());
  for (const run of runs) {
    const { usage, state } = replayRun(run.events, { enforce: false });
    const implement = new Set(
      run.stages.filter((s) => s.kind === 'implement').map((s) => s.id),
    );
    /** @type {Map<string, { stageId: string, tokens: number, turns: number, hasTurns: boolean }>} */
    const groups = new Map();
    /** @param {Map<string, any>} map @param {string} key @param {any} init */
    const group = (map, key, init) => {
      if (!map.has(key))
        map.set(key, { tokens: 0, turns: 0, hasTurns: false, ...init });
      return map.get(key);
    };
    /** @type {Map<string, any>} */
    const attempts = new Map();
    /** @type {Map<string, any>} */
    const items = new Map();
    /** @type {Map<string, any>} */
    const shared = new Map();
    let workflow = 0;
    for (const record of usage) {
      const targets = [
        group(groups, `${record.stageId}#${record.stageAttempt}`, {
          stageId: record.stageId,
        }),
      ];
      if (implement.has(record.stageId)) {
        if (record.itemKey === undefined)
          targets.push(group(shared, record.stageId, {}));
        else
          targets.push(
            group(attempts, record.attemptId, { stageId: record.stageId }),
            group(items, `${record.stageId}#${record.itemKey}`, {
              stageId: record.stageId,
            }),
          );
      }
      for (const target of targets) {
        target[record.metric] += record.amount;
        if (record.metric === 'turns') target.hasTurns = true;
      }
      if (record.metric === 'tokens') workflow += record.amount;
    }
    for (const g of groups.values()) {
      at(samples.stages, g.stageId).tokens.push(g.tokens);
      if (g.hasTurns) at(samples.stages, g.stageId).turns.push(g.turns);
    }
    for (const g of attempts.values()) {
      at(samples.perItem, g.stageId).tokens.push(g.tokens);
      if (g.hasTurns) at(samples.perItem, g.stageId).turns.push(g.turns);
    }
    // Items count from spawned attempts, so an item that used nothing still shares.
    for (const stageId of implement) {
      const keys = new Set(
        Object.values(state.attempts)
          .filter((a) => a.stageId === stageId && a.itemKey !== undefined)
          .map((a) => /** @type {string} */ (a.itemKey)),
      );
      if (keys.size === 0) continue;
      const common = shared.get(stageId) ?? {
        tokens: 0,
        turns: 0,
        hasTurns: false,
      };
      const own = [...keys].map(
        (key) =>
          items.get(`${stageId}#${key}`) ?? {
            tokens: 0,
            turns: 0,
            hasTurns: false,
          },
      );
      const hasTurns = common.hasTurns || own.some((g) => g.hasTurns);
      for (const g of own) {
        at(samples.itemShare, stageId).tokens.push(
          g.tokens + common.tokens / keys.size,
        );
        if (hasTurns)
          at(samples.itemShare, stageId).turns.push(
            g.turns + common.turns / keys.size,
          );
      }
    }
    samples.workflow.push(workflow);
  }
  return samples;
}

/**
 * new = max(old, roundUp(p90 × 1.5 × scale)); never lower. Headroom = new ÷ measured p90.
 * @param {string} level @param {'tokens' | 'turns'} metric @param {number} old
 * @param {number[]} computedFrom @param {number[]} measured @param {number} [scale]
 * @returns {Row}
 */
function row(level, metric, old, computedFrom, measured, scale = 1) {
  const basis = p90(computedFrom);
  const computed =
    basis === undefined
      ? undefined
      : roundUp(basis * FACTOR * scale, STEP[metric]);
  const value = Math.max(old, computed ?? old);
  const measuredP90 = p90(measured);
  const headroom =
    measuredP90 === undefined || measuredP90 === 0
      ? undefined
      : value / measuredP90;
  return {
    level,
    metric,
    n: measured.length,
    ...(measuredP90 === undefined ? {} : { p90: measuredP90 }),
    old,
    ...(computed === undefined ? {} : { computed }),
    value,
    ...(headroom === undefined ? {} : { headroom }),
    loose: headroom !== undefined && headroom > LOOSE,
  };
}

/**
 * Applies §4.3 to every budget the baseline configures; fields the baseline
 * leaves out stay out. hardLimitMultiplier is carried unchanged.
 * @param {Samples} samples
 * @param {Baseline} baseline
 * @returns {{ budgets: Budgets, rows: Row[] }}
 */
export function recommend(samples, baseline) {
  /** @type {Row[]} */
  const rows = [];
  /** @type {Record<string, StageBudget>} */
  const stages = {};
  for (const [id, old] of Object.entries(baseline.budgets.stages)) {
    const info = baseline.stages.find((s) => s.id === id);
    const measured = samples.stages[id] ?? series();
    /** @type {StageBudget} */
    const next = { ...old };
    if (info?.kind === 'implement') {
      if (info.maxParallel === undefined)
        throw new Error(`Stage ${id}: implement needs maxParallel`);
      const share = samples.itemShare[id] ?? series();
      const scale = info.maxParallel * 2;
      const tokens = row(
        id,
        'tokens',
        old.tokens,
        share.tokens,
        measured.tokens,
        scale,
      );
      rows.push(tokens);
      next.tokens = tokens.value;
      if (old.maxTurns !== undefined) {
        const turns = row(
          id,
          'turns',
          old.maxTurns,
          share.turns,
          measured.turns,
          scale,
        );
        rows.push(turns);
        next.maxTurns = turns.value;
      }
    } else {
      const tokens = row(
        id,
        'tokens',
        old.tokens,
        measured.tokens,
        measured.tokens,
      );
      rows.push(tokens);
      next.tokens = tokens.value;
      if (old.maxTurns !== undefined) {
        const turns = row(
          id,
          'turns',
          old.maxTurns,
          measured.turns,
          measured.turns,
        );
        rows.push(turns);
        next.maxTurns = turns.value;
      }
    }
    if (old.perItem !== undefined) {
      const item = samples.perItem[id] ?? series();
      const tokens = row(
        `${id}.perItem`,
        'tokens',
        old.perItem.tokens,
        item.tokens,
        item.tokens,
      );
      rows.push(tokens);
      next.perItem = { ...old.perItem, tokens: tokens.value };
      if (old.perItem.maxTurns !== undefined) {
        const turns = row(
          `${id}.perItem`,
          'turns',
          old.perItem.maxTurns,
          item.turns,
          item.turns,
        );
        rows.push(turns);
        next.perItem.maxTurns = turns.value;
      }
    }
    stages[id] = next;
  }
  /** @type {Budgets} */
  const budgets = {
    stages,
    hardLimitMultiplier: baseline.budgets.hardLimitMultiplier,
  };
  if (baseline.budgets.workflow !== undefined) {
    const workflow = row(
      'workflow',
      'tokens',
      baseline.budgets.workflow.tokens,
      samples.workflow,
      samples.workflow,
    );
    rows.push(workflow);
    budgets.workflow = { tokens: workflow.value };
  }
  return { budgets, rows };
}

/**
 * Criterion 3 for every configured threshold of `budgets`.
 * @param {Baseline} baseline
 * @param {Budgets} budgets
 */
export function thresholdChecks(baseline, budgets) {
  const hardLimitMultiplier = budgets.hardLimitMultiplier;
  const checks = [];
  for (const stage of baseline.stages) {
    const budget = budgets.stages[stage.id];
    if (budget === undefined) continue;
    /** @type {[ 'item' | 'stage', 'tokens' | 'turns', number | undefined ][]} */
    const cases = [
      ['stage', 'tokens', budget.tokens],
      ['stage', 'turns', budget.maxTurns],
      ['item', 'tokens', budget.perItem?.tokens],
      ['item', 'turns', budget.perItem?.maxTurns],
    ];
    for (const [scope, metric, value] of cases)
      if (value !== undefined)
        checks.push(
          thresholdMechanism({
            scope,
            metric,
            stage,
            budget: value,
            hardLimitMultiplier,
          }),
        );
  }
  const first = baseline.stages[0];
  if (budgets.workflow !== undefined && first !== undefined)
    checks.push(
      thresholdMechanism({
        scope: 'workflow',
        metric: 'tokens',
        stage: first,
        budget: budgets.workflow.tokens,
        hardLimitMultiplier,
      }),
    );
  return checks;
}

/**
 * @param {{ exports: { name: string, json: unknown }[], baseline: Baseline }} input
 */
export function calibrate({ exports, baseline }) {
  const runs = exports.flatMap(({ name, json }) =>
    runsFromExport(json).map((run, index, all) => ({
      ...run,
      name: all.length === 1 ? name : `${name}#${index + 1}`,
    })),
  );
  const samples = samplesFromRuns(runs);
  const { budgets, rows } = recommend(samples, baseline);
  const notes = runs
    .filter(
      (run) => JSON.stringify(run.budgets) !== JSON.stringify(baseline.budgets),
    )
    .map(
      (run) =>
        `${run.name}: applied budgets differ from the baseline (start-time overrides?)`,
    );
  const replay = runs.map((run) => {
    const result = replayRun(run.events, { budgets, enforce: true });
    return {
      run: run.name,
      budgetEvents: result.hits.length,
      hits: result.hits,
      warnings: result.warnings.length,
      ok: result.hits.length === 0,
    };
  });
  const headroom = runs.map((run, index) => {
    const used = samples.workflow[index] ?? 0;
    const budget = budgets.workflow?.tokens;
    const ratio =
      budget === undefined || used === 0 ? undefined : budget / used;
    return {
      run: run.name,
      used,
      ...(budget === undefined ? {} : { budget }),
      ...(ratio === undefined ? {} : { ratio }),
      ok: ratio !== undefined && ratio >= MIN_WORKFLOW_HEADROOM,
    };
  });
  const thresholds = thresholdChecks(baseline, budgets);
  const criteria = {
    replay: { ok: replay.every((r) => r.ok), runs: replay },
    workflowHeadroom: { ok: headroom.every((h) => h.ok), runs: headroom },
    thresholds: { ok: thresholds.every((t) => t.ok), checks: thresholds },
  };
  return {
    runs: runs.length,
    rows,
    budgets,
    criteria,
    notes,
    snippet: renderSnippet(baseline, budgets),
    ok:
      criteria.replay.ok &&
      criteria.workflowHeadroom.ok &&
      criteria.thresholds.ok,
  };
}

/** @param {number | undefined} n */
const num = (n) =>
  n === undefined ? '—' : Math.round(n).toLocaleString('en-US');
/** @param {number | undefined} r */
const ratio = (r) => (r === undefined ? '—' : `${r.toFixed(2)}×`);
/** @param {boolean} ok */
const verdict = (ok) => (ok ? 'PASS' : 'FAIL');

/** @param {ReturnType<typeof calibrate>} report */
export function formatReport(report) {
  const lines = [
    `Budget calibration (runs n=${report.runs}; small-scale samples, read n per level)`,
    '',
    '| level | metric | n | p90 | old | p90×1.5 rounded | new | headroom |',
    '|---|---|---|---|---|---|---|---|',
    ...report.rows.map(
      (r) =>
        `| ${r.level} | ${r.metric} | ${r.n} | ${num(r.p90)} | ${num(r.old)} | ${num(r.computed)} | ${num(r.value)}${r.value > r.old ? ' (raised)' : ''} | ${ratio(r.headroom)}${r.loose ? ' loose' : ''} |`,
    ),
    '',
    `Criterion 1 (replay, enforcement on, new values → 0 budget.*): ${verdict(report.criteria.replay.ok)}`,
    ...report.criteria.replay.runs.map(
      (r) =>
        `  ${r.run}: ${r.budgetEvents} budget.* events${r.warnings ? `, ${r.warnings} replay warnings` : ''}` +
        r.hits
          .map(
            (h) =>
              `\n    ${h.type} ${h.scope} ${h.metric}${h.stageId ? ` ${h.stageId}` : ''}${h.itemKey ? ` ${h.itemKey}` : ''}: ${h.used} ≥ ${h.threshold}`,
          )
          .join(''),
    ),
    `Criterion 2 (workflow budget ≥ ${MIN_WORKFLOW_HEADROOM}× run usage): ${verdict(report.criteria.workflowHeadroom.ok)}`,
    ...report.criteria.workflowHeadroom.runs.map(
      (h) =>
        `  ${h.run}: ${num(h.budget)} / ${num(h.used)} = ${ratio(h.ratio)}`,
    ),
    `Criterion 3 (threshold mechanism: exactly one exceeded, then one hard limit): ${verdict(report.criteria.thresholds.ok)}`,
    ...report.criteria.thresholds.checks.map(
      (t) =>
        `  ${t.scope}${t.stageId ? ` ${t.stageId}` : ''} ${t.metric} ${num(t.budget)} / hard ${num(t.hard)}: ${verdict(t.ok)}`,
    ),
    ...(report.notes.length
      ? ['', 'Notes:', ...report.notes.map((n) => `  ${n}`)]
      : []),
    '',
    'Suggested template values (only up; hardLimitMultiplier unchanged):',
    report.snippet,
  ];
  return lines.join('\n');
}

const DEFAULT_BASELINE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../packages/templates/feature-to-pr.yaml',
);

/** @param {string[]} argv @returns {number} exit code */
export function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      events: { type: 'string', multiple: true },
      baseline: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  if (!values.events?.length) {
    console.error(
      'Usage: pnpm budget:calibrate --events <export.json> [--events <export.json> …] [--baseline <yaml>] [--json]',
    );
    return 2;
  }
  const baseline = parseBaseline(
    readFileSync(values.baseline ?? DEFAULT_BASELINE, 'utf8'),
  );
  const report = calibrate({
    exports: values.events.map((file) => ({
      name: file,
      json: JSON.parse(readFileSync(file, 'utf8')),
    })),
    baseline,
  });
  console.log(
    values.json ? JSON.stringify(report, null, 2) : formatReport(report),
  );
  return report.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  process.exitCode = main(process.argv.slice(2));
