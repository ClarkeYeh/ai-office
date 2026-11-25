import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBaseline, parseFlowMapping, renderSnippet } from './baseline.mjs';
import {
  calibrate,
  formatReport,
  main,
  p90,
  recommend,
  roundUp,
  samplesFromRuns,
  thresholdChecks,
} from './calibrate.mjs';
import { replayRun, runsFromExport, thresholdMechanism } from './replay.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(here, '../../packages/templates/feature-to-pr.yaml');
const template = () => parseBaseline(readFileSync(TEMPLATE, 'utf8'));
// What a B4-masked export leaves of free text.
const MASK = '‹text len=12 sha=000000000000›';

/**
 * A masked-shape export built only from usage numbers (no transcript text).
 * @param {{ id: string, stageId: string, purpose: string, itemKey?: string, tokens: number[], turns?: number[] }[]} attempts
 * @param {{ workflowId?: string, extra?: any[] }} [options]
 */
function syntheticExport(
  attempts,
  { workflowId = 'wf-sample', extra = [] } = {},
) {
  const baseline = template();
  let seq = 0;
  /** @param {string} type @param {any} payload @param {any} [scope] */
  const event = (type, payload, scope = {}) => ({
    id: `evt-${++seq}`,
    seq,
    type,
    workflowId,
    occurredAt: new Date(Date.UTC(2000, 0, 1, 0, 0, seq)).toISOString(),
    source: type.startsWith('usage.') ? 'runtime' : 'engine',
    provenance: 'observed',
    ...scope,
    payload,
  });
  const events = [
    event('workflow.started', {
      templateSnapshot: { id: 'feature-to-pr', stages: baseline.stages },
      requirement: MASK,
      shortId: 'ab12',
      budgets: baseline.budgets,
      limits: { globalAgents: 4, budgetEnforcement: 'off' },
    }),
    ...extra.map((e) => event(e.type, e.payload, e.scope)),
  ];
  for (const stage of baseline.stages) {
    const own = attempts.filter((a) => a.stageId === stage.id);
    if (own.length === 0) continue;
    events.push(
      event(
        'stage.started',
        { stageId: stage.id, kind: stage.kind, attempt: 1, mode: 'initial' },
        { stageId: stage.id },
      ),
    );
    for (const a of own) {
      const scope = { stageId: stage.id, attemptId: a.id };
      events.push(
        event(
          'seat.spawned',
          {
            seatId: `seat-${a.id}`,
            attemptId: a.id,
            attempt: 1,
            stageId: stage.id,
            role: MASK,
            agent: 'claude-code',
            purpose: a.purpose,
            keepOpen: false,
            ...(a.itemKey === undefined ? {} : { itemKey: a.itemKey }),
            spawnCommandId: `cmd-${a.id}`,
          },
          scope,
        ),
        ...a.tokens.map((n) =>
          event(
            'usage.tokens',
            {
              attemptId: a.id,
              inputUncached: n,
              output: 0,
              cacheRead: 7,
              cacheWrite: 0,
              budgetTokens: n,
            },
            scope,
          ),
        ),
        ...(a.turns ?? []).map((n) =>
          event('usage.turns', { attemptId: a.id, turns: n }, scope),
        ),
      );
    }
  }
  return {
    exportedAt: '2000-01-01T00:00:00.000Z',
    aiOfficeCommit: '0'.repeat(40),
    orcaVersion: '1.4.272',
    events,
  };
}

// M3-T17 (PR #166, reference n=1): budget tokens per attempt; no turn counts reported.
const M3_T17 = [
  {
    id: 'm-lead',
    stageId: 'meeting',
    purpose: 'facilitator',
    tokens: [20_000, 17_600],
  },
  { id: 'm-pm', stageId: 'meeting', purpose: 'participant', tokens: [37_800] },
  {
    id: 'm-arch',
    stageId: 'meeting',
    purpose: 'participant',
    tokens: [37_900],
  },
  { id: 'm-eng', stageId: 'meeting', purpose: 'participant', tokens: [65_900] },
  { id: 'b-lead', stageId: 'breakdown', purpose: 'planner', tokens: [26_000] },
  {
    id: 'i-a',
    stageId: 'implement',
    purpose: 'worker',
    itemKey: 'A',
    tokens: [26_200],
  },
  {
    id: 'i-b',
    stageId: 'implement',
    purpose: 'worker',
    itemKey: 'B',
    tokens: [40_300],
  },
  {
    id: 'i-merge',
    stageId: 'implement',
    purpose: 'integrator',
    tokens: [33_800],
  },
  {
    id: 'g-int',
    stageId: 'integrate',
    purpose: 'integrator',
    tokens: [27_600],
  },
];

/** @param {ReturnType<typeof calibrate>} report @param {string} level @param {string} metric */
const rowOf = (report, level, metric) => {
  const found = report.rows.find(
    (r) => r.level === level && r.metric === metric,
  );
  assert.ok(found, `${level} ${metric}`);
  return found;
};

test('p90 is nearest rank and rounding only goes up', () => {
  assert.equal(p90([]), undefined);
  assert.equal(p90([5]), 5);
  assert.equal(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);
  assert.equal(p90([3, 1, 2, 4]), 4);
  assert.equal(
    p90([152_728, 145_776, 102_899, 68_619, 88_978, 109_400]),
    152_728,
  );
  assert.equal(roundUp(229_092, 50_000), 250_000);
  assert.equal(roundUp(250_000, 50_000), 250_000);
  assert.equal(roundUp(76.5, 10), 80);
});

test('M2-T18 samples reproduce the recorded calibration', () => {
  // M2_VERIFICATION.md M2-T18 table, against the defaults before that calibration.
  const baseline = template();
  baseline.budgets.stages.meeting = { tokens: 300_000, maxTurns: 60 };
  const samples = {
    runs: 3,
    stages: {
      meeting: {
        tokens: [145_776, 152_728, 102_899, 68_619, 88_978, 109_400],
        turns: [51, 49, 29, 26, 29, 27],
      },
      breakdown: {
        tokens: [23_998, 23_740, 24_643, 23_934, 23_684, 23_858],
        turns: [2, 1, 4, 2, 1, 1],
      },
      implement: { tokens: [145_904, 137_199, 128_677], turns: [56, 58, 57] },
      integrate: { tokens: [27_745, 27_801, 26_923], turns: [7, 6, 4] },
    },
    perItem: {
      implement: {
        tokens: [27_379, 24_494, 29_983, 29_885],
        turns: [12.3, 13.3, 16.5, 15],
      },
    },
    itemShare: { implement: { tokens: [72_952, 68_600, 64_339], turns: [] } },
    workflow: [266_202, 277_662, 288_858],
  };
  const { budgets, rows } = recommend(samples, baseline);
  const pick = (/** @type {string} */ level, /** @type {string} */ metric) =>
    rows.find((r) => r.level === level && r.metric === metric);
  assert.deepEqual(
    [pick('meeting', 'tokens')?.computed, pick('meeting', 'turns')?.computed],
    [250_000, 80],
  );
  assert.deepEqual(budgets.stages.meeting, { tokens: 300_000, maxTurns: 80 });
  assert.deepEqual(
    [
      pick('breakdown', 'tokens')?.computed,
      pick('breakdown', 'turns')?.computed,
    ],
    [50_000, 10],
  );
  assert.equal(pick('implement', 'tokens')?.computed, 700_000);
  assert.deepEqual(
    [
      pick('implement.perItem', 'tokens')?.computed,
      pick('implement.perItem', 'turns')?.computed,
    ],
    [50_000, 30],
  );
  assert.deepEqual(
    [
      pick('integrate', 'tokens')?.computed,
      pick('integrate', 'turns')?.computed,
    ],
    [50_000, 20],
  );
  assert.equal(pick('workflow', 'tokens')?.computed, 450_000);
  // Everything else stays at the (higher) defaults; the multiplier is untouched.
  assert.deepEqual(budgets, {
    ...template().budgets,
    stages: {
      ...template().budgets.stages,
      meeting: { tokens: 300_000, maxTurns: 80 },
    },
  });
  assert.equal(pick('meeting', 'turns')?.value, 80);
  assert.equal(pick('meeting', 'turns')?.old, 60);
});

test('M3-T17 export: values unchanged, headroom reported, all criteria hold', () => {
  const report = calibrate({
    exports: [{ name: 'm3-t17', json: syntheticExport(M3_T17) }],
    baseline: template(),
  });
  assert.deepEqual(report.budgets, template().budgets);
  const meeting = rowOf(report, 'meeting', 'tokens');
  assert.equal(meeting.measured, 179_200);
  assert.equal(meeting.computed, 300_000);
  assert.equal(meeting.headroom?.toFixed(2), '1.67');
  assert.equal(meeting.loose, false);
  const implement = rowOf(report, 'implement', 'tokens');
  assert.equal(implement.measured, 100_300);
  // Item B 40,300 + half the merge queue's 33,800 → 57,200 × 1.5 × 6.
  assert.equal(implement.computed, 550_000);
  assert.equal(implement.loose, true);
  const perItem = rowOf(report, 'implement.perItem', 'tokens');
  assert.deepEqual(
    [perItem.n, perItem.measured, perItem.computed],
    [2, 40_300, 100_000],
  );
  assert.equal(perItem.loose, false);
  const perItemTurns = rowOf(report, 'implement.perItem', 'turns');
  assert.deepEqual([perItemTurns.n, perItemTurns.value], [0, 120]);
  assert.equal(perItemTurns.headroom, undefined);
  assert.equal(rowOf(report, 'workflow', 'tokens').stat, 'max');
  assert.equal(rowOf(report, 'workflow', 'tokens').measured, 333_100);
  assert.equal(report.criteria.replay.runs[0]?.budgetEvents, 0);
  assert.equal(
    report.criteria.workflowHeadroom.runs[0]?.ratio?.toFixed(2),
    '9.01',
  );
  assert.equal(report.criteria.thresholds.checks.length, 10);
  assert.equal(report.ok, true);
  const text = formatReport(report);
  assert.match(text, /\| implement \| tokens \| 1 \| p90 100,300 .* loose \|/);
  assert.match(text, /Criterion 1 .*: PASS/);
  assert.match(text, /workflowBudget: \{ tokens: 3000000 \}/);
});

test('only up: a low baseline is raised to cover the run, a high one is kept', () => {
  const baseline = template();
  baseline.budgets.stages.meeting = { tokens: 100_000, maxTurns: 10 };
  baseline.budgets.workflow = { tokens: 200_000 };
  const attempts = [
    {
      id: 'm-lead',
      stageId: 'meeting',
      purpose: 'facilitator',
      tokens: [179_200],
      turns: [30, 21],
    },
    ...M3_T17.filter((a) => a.stageId !== 'meeting'),
  ];
  const report = calibrate({
    exports: [{ name: 'low', json: syntheticExport(attempts) }],
    baseline,
  });
  assert.deepEqual(report.budgets.stages.meeting, {
    tokens: 300_000,
    maxTurns: 80,
  });
  assert.equal(report.budgets.workflow?.tokens, 500_000);
  assert.equal(report.budgets.stages.breakdown?.tokens, 200_000);
  assert.equal(report.budgets.hardLimitMultiplier, 2);
  assert.equal(report.ok, true);
  assert.match(formatReport(report), /300,000 \(raised\)/);
});

test('criterion 1 replays through decide: old budget events are dropped, tight values hit', () => {
  const json = syntheticExport(M3_T17, {
    extra: [
      {
        type: 'budget.exceeded',
        payload: {
          scope: 'workflow',
          metric: 'tokens',
          used: 9,
          budget: 1,
          threshold: 1,
        },
      },
    ],
  });
  const [run] = runsFromExport(json);
  assert.ok(run);
  assert.equal(
    replayRun(run.events, { budgets: template().budgets, enforce: true }).hits
      .length,
    0,
  );
  const tight = template().budgets;
  tight.stages.meeting = { tokens: 100_000, maxTurns: 80 };
  tight.stages.implement = {
    tokens: 1_800_000,
    perItem: { tokens: 30_000, maxTurns: 120 },
  };
  // A recorded workflow alert would suppress this one if it were replayed.
  tight.workflow = { tokens: 300_000 };
  const { hits } = replayRun(run.events, { budgets: tight, enforce: true });
  assert.deepEqual(
    hits.map((h) =>
      `${h.type} ${h.scope} ${h.stageId ?? ''} ${h.itemKey ?? ''}`.trim(),
    ),
    [
      'budget.exceeded stage meeting',
      'budget.exceeded item implement B',
      'budget.exceeded workflow',
    ],
  );
  // With enforcement off nothing is evaluated (S25).
  assert.equal(
    replayRun(run.events, { budgets: tight, enforce: false }).hits.length,
    0,
  );
});

test('criterion 2 fails when the workflow budget is under 1.5× the run', () => {
  const baseline = template();
  delete baseline.budgets.workflow;
  const report = calibrate({
    exports: [{ name: 'x', json: syntheticExport(M3_T17) }],
    baseline,
  });
  assert.equal(report.criteria.workflowHeadroom.ok, false);
  assert.equal(report.ok, false);
});

test('criterion 3: crossing a threshold, then its hard limit, alerts exactly once each', () => {
  const checks = thresholdChecks(template(), template().budgets);
  assert.deepEqual(
    checks.map((c) =>
      `${c.scope} ${c.stageId ?? ''} ${c.metric}`.replace('  ', ' '),
    ),
    [
      'stage meeting tokens',
      'stage meeting turns',
      'stage breakdown tokens',
      'stage breakdown turns',
      'stage implement tokens',
      'item implement tokens',
      'item implement turns',
      'stage integrate tokens',
      'stage integrate turns',
      'workflow tokens',
    ],
  );
  for (const check of checks) {
    assert.equal(check.ok, true, `${check.scope} ${check.metric}`);
    assert.deepEqual(check.steps, [
      [],
      [`budget.exceeded:${check.scope}`],
      [],
      [`budget.hard_limit:${check.scope}`],
      [],
    ]);
  }
  const triple = thresholdMechanism({
    scope: 'item',
    metric: 'tokens',
    stage: { id: 'implement', kind: 'implement' },
    budget: 400_000,
    hardLimitMultiplier: 3,
  });
  assert.equal(triple.hard, 1_200_000);
  assert.equal(triple.ok, true);
  assert.throws(() =>
    thresholdMechanism({
      scope: 'stage',
      metric: 'turns',
      stage: { id: 'meeting', kind: 'meeting' },
      budget: 1,
      hardLimitMultiplier: 2,
    }),
  );
});

test('samples: rework attempts count per attempt and add to the item share', () => {
  const [run] = runsFromExport(
    syntheticExport([
      {
        id: 'a1',
        stageId: 'implement',
        purpose: 'worker',
        itemKey: 'A',
        tokens: [10_000],
        turns: [5],
      },
      {
        id: 'a2',
        stageId: 'implement',
        purpose: 'worker',
        itemKey: 'A',
        tokens: [20_000],
        turns: [7],
      },
      {
        id: 'b1',
        stageId: 'implement',
        purpose: 'worker',
        itemKey: 'B',
        tokens: [5_000],
      },
      {
        id: 'q',
        stageId: 'implement',
        purpose: 'oncall',
        tokens: [3_000],
        turns: [2],
      },
    ]),
  );
  assert.ok(run);
  const samples = samplesFromRuns([run]);
  assert.deepEqual(samples.perItem.implement, {
    tokens: [10_000, 20_000, 5_000],
    turns: [5, 7],
  });
  assert.deepEqual(samples.itemShare.implement, {
    tokens: [31_500, 6_500],
    turns: [13, 1],
  });
  assert.deepEqual(samples.stages.implement, { tokens: [38_000], turns: [14] });
  assert.deepEqual(samples.workflow, [38_000]);
});

test('exports: bare arrays and several workflows split into runs', () => {
  const a = syntheticExport(M3_T17, { workflowId: 'wf-a' }).events;
  const b = syntheticExport(M3_T17, { workflowId: 'wf-b' }).events.map((e) => ({
    ...e,
    seq: e.seq + 1000,
  }));
  const runs = runsFromExport([...b, ...a]);
  assert.deepEqual(
    runs.map((r) => r.workflowId),
    ['wf-a', 'wf-b'],
  );
  assert.throws(() => runsFromExport({}), /no events/);
  assert.throws(() => runsFromExport({ events: [] }), /no workflow.started/);
  const report = calibrate({
    exports: [{ name: 'both', json: [...a, ...b] }],
    baseline: template(),
  });
  assert.deepEqual(
    report.criteria.replay.runs.map((r) => r.run),
    ['both#1', 'both#2'],
  );
  assert.equal(rowOf(report, 'meeting', 'tokens').n, 2);
});

test('baseline: reads the built-in template and renders the same values', () => {
  const baseline = template();
  assert.deepEqual(baseline.budgets, {
    stages: {
      meeting: { tokens: 300_000, maxTurns: 120 },
      breakdown: { tokens: 200_000, maxTurns: 40 },
      implement: {
        tokens: 1_800_000,
        perItem: { tokens: 400_000, maxTurns: 120 },
      },
      integrate: { tokens: 200_000, maxTurns: 60 },
    },
    workflow: { tokens: 3_000_000 },
    hardLimitMultiplier: 2,
  });
  assert.deepEqual(
    baseline.stages.find((s) => s.id === 'implement'),
    {
      id: 'implement',
      kind: 'implement',
      maxParallel: 3,
    },
  );
  const snippet = renderSnippet(baseline, baseline.budgets);
  assert.match(
    snippet,
    /- id: implement\n {4}budget: \{ tokens: 1800000, perItem: \{ tokens: 400000, maxTurns: 120 \} \}/,
  );
  assert.deepEqual(parseFlowMapping('{ a: 1, b: { c: x } }'), {
    a: 1,
    b: { c: 'x' },
  });
  assert.throws(() => parseFlowMapping('{ a: 1'), /Malformed/);
  assert.throws(
    () => parseBaseline('stages:\n  - id: s\n    kind: meeting\n'),
    /hardLimitMultiplier/,
  );
  assert.throws(
    () =>
      parseBaseline(
        'defaults:\n  budget: { hardLimitMultiplier: 2 }\nstages:\n  - id: s\n    budget:\n      tokens: 1\n',
      ),
    /flow mapping/,
  );
});

test('CLI: reads an export file and exits by the criteria', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-budget-'));
  try {
    const file = join(dir, 'export.json');
    writeFileSync(file, JSON.stringify(syntheticExport(M3_T17)));
    const out = execFileSync(
      process.execPath,
      [resolve(here, 'calibrate.mjs'), '--events', file],
      {
        encoding: 'utf8',
      },
    );
    assert.match(out, /Criterion 2 .*: PASS/);
    const json = JSON.parse(
      execFileSync(
        process.execPath,
        [resolve(here, 'calibrate.mjs'), '--events', file, '--json'],
        {
          encoding: 'utf8',
        },
      ),
    );
    assert.equal(json.ok, true);
    const low = join(dir, 'low.yaml');
    writeFileSync(
      low,
      'defaults:\n  budget: { hardLimitMultiplier: 2 }\nstages:\n  - id: meeting\n    kind: meeting\n    budget: { tokens: 50000 }\n',
    );
    // No workflow budget in this baseline → criterion 2 fails → exit 1.
    const original = console.log;
    console.log = () => {};
    try {
      assert.equal(main(['--events', file, '--baseline', low]), 1);
    } finally {
      console.log = original;
    }
    const error = console.error;
    console.error = () => {};
    try {
      assert.equal(main([]), 2);
    } finally {
      console.error = error;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('criteria 1 and 2 hold for any n: an outlier run lifts its levels (coordinator ruling)', () => {
  const baseline = template();
  baseline.budgets.workflow = { tokens: 100_000 };
  baseline.budgets.stages.meeting = { tokens: 100_000, maxTurns: 10 };
  const exports = Array.from({ length: 10 }, (_, i) => ({
    name: `run-${i}`,
    json: syntheticExport([
      {
        id: 'm',
        stageId: 'meeting',
        purpose: 'facilitator',
        tokens: [i === 9 ? 280_000 : 100_000],
        turns: [i === 9 ? 47 : 12],
      },
    ]),
  }));
  const report = calibrate({ exports, baseline });
  // Workflow: max 280,000 × 1.5 → 450,000 (criterion 2 per accepted run).
  const workflow = rowOf(report, 'workflow', 'tokens');
  assert.deepEqual(
    [workflow.n, workflow.stat, workflow.measured, workflow.value],
    [10, 'max', 280_000, 450_000],
  );
  assert.equal(
    Math.min(
      ...report.criteria.workflowHeadroom.runs.map((r) => r.ratio ?? 0),
    ).toFixed(2),
    '1.61',
  );
  // Meeting: p90 100,000 × 1.5 → 150,000 alone would let run-9 (280,000)
  // through; the run floor 280,000 × 1.1 → 350,000 wins. Turns: p90 12 → 20,
  // floor 47 × 1.1 → 60.
  const tokens = rowOf(report, 'meeting', 'tokens');
  assert.deepEqual(
    [tokens.measured, tokens.computed, tokens.runFloor, tokens.value],
    [100_000, 150_000, 350_000, 350_000],
  );
  const turns = rowOf(report, 'meeting', 'turns');
  assert.deepEqual([turns.computed, turns.runFloor, turns.value], [20, 60, 60]);
  assert.deepEqual(
    report.criteria.replay.runs.map((r) => r.budgetEvents),
    Array(10).fill(0),
  );
  assert.equal(report.ok, true);
  assert.match(
    formatReport(report),
    /\| meeting \| tokens \| 10 \| p90 100,000 \| 100,000 \| 150,000 \| 350,000 \| 350,000 \(raised\) \|/,
  );
  // Without the floor, the same values fail criterion 1 on run-9 only.
  /** @type {typeof report.budgets} */
  const p90Only = JSON.parse(JSON.stringify(report.budgets));
  p90Only.stages.meeting = { tokens: 150_000, maxTurns: 20 };
  const hitsFor = (/** @type {number} */ index) => {
    const [run] = runsFromExport(exports[index]?.json);
    assert.ok(run);
    return replayRun(run.events, { budgets: p90Only, enforce: true }).hits;
  };
  assert.equal(hitsFor(0).length, 0);
  const outlier = hitsFor(9);
  assert.ok(outlier.length > 0);
  assert.ok(
    outlier.every((h) => h.scope === 'stage' && h.stageId === 'meeting'),
  );
});

test('baseline reader is strict about the baseline keys', () => {
  const ok = [
    'apiVersion: ai-office/v1alpha1',
    'defaults:',
    '  budget: { hardLimitMultiplier: 2 }',
    '  workflowBudget: { tokens: 900 }',
    'stages:',
    '  - id: meeting',
    '    kind: meeting',
    '    budget: { tokens: 300, maxTurns: 8 } # comment',
    '    gate:',
    '      { id: g, title: t }',
    '  - id: implement',
    '    kind: implement',
    '    maxParallel: 3',
    '    budget: { tokens: 600, perItem: { tokens: 200 } }',
  ];
  assert.deepEqual(parseBaseline(ok.join('\n')).budgets, {
    stages: {
      meeting: { tokens: 300, maxTurns: 8 },
      implement: { tokens: 600, perItem: { tokens: 200 } },
    },
    workflow: { tokens: 900 },
    hardLimitMultiplier: 2,
  });
  /** @param {number} line @param {string} text */
  const swap = (line, text) =>
    ok.map((l, i) => (i === line ? text : l)).join('\n');
  const cases = [
    [swap(0, 'extra: 1'), /unexpected top-level key extra/],
    [
      swap(2, '  budget: { hardLimitMultiplier: 2, tokens: 5 }'),
      /unexpected key tokens/,
    ],
    [swap(2, '  budget: { hardLimitMultiplier: 0.5 }'), /≥ 1/],
    [swap(2, '  budget:'), /single-line flow mapping/],
    [swap(3, '  workflowBudget: { tokens: 9.5 }'), /positive integer/],
    [
      swap(7, '    budget: { tokens: 300, maxturns: 8 }'),
      /unexpected key maxturns/,
    ],
    [swap(7, '    budget: { maxTurns: 8 }'), /missing tokens/],
    [
      swap(7, '    budget: { tokens: 300, tokens: 400 }'),
      /Duplicate key tokens/,
    ],
    [swap(7, '    budget: { tokens: lots }'), /positive integer/],
    [swap(7, '    budget: { tokens: 300 } extra'), /Malformed/],
    [swap(9, '      budget: { tokens: 1 }'), /unexpected budget here/],
    [swap(9, '    maxTurns: 5'), /unexpected maxTurns here/],
    [swap(12, '    maxParallel: 0'), /positive integer/],
    [swap(12, '    role: engineer'), /maxParallel belongs to implement/],
    [swap(6, '    kind: meetings'), /unknown kind meetings/],
    [swap(10, '  - id: meeting'), /duplicate stage meeting/],
    [swap(13, '    perItem: { tokens: 200 }'), /unexpected perItem here/],
    [swap(12, '    tokens: 3'), /unexpected tokens here/],
    [
      swap(6, '    kind: meeting\n    maxParallel: 2'),
      /maxParallel belongs to implement/,
    ],
    [ok.join('\n') + '\n    budget: { tokens: 1 }', /duplicate budget/],
    [
      ok.join('\n') + '\nroles:\n  lead:\n    budget: { tokens: 1 }',
      /unexpected budget here/,
    ],
    [ok.join('\n').replace('    kind: meeting\n', ''), /meeting has no kind/],
    [
      ok.join('\n').replace('  budget: { hardLimitMultiplier: 2 }\n', ''),
      /no defaults.budget/,
    ],
    [ok.join('\n').replace('    kind', '\tkind'), /tabs/],
  ];
  for (const [yaml, error] of cases)
    assert.throws(
      () => parseBaseline(/** @type {string} */ (yaml)),
      /** @type {RegExp} */ (error),
    );
});
