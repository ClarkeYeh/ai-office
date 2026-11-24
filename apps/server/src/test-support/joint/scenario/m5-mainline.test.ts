import { parse } from 'yaml';
import { describe, expect, test } from 'vitest';
import { WorkItemDraftSchema } from '@ai-office/contracts/events';
import { WorkflowTemplateSchema } from '@ai-office/contracts/template';
import {
  CODE_NAME,
  ITEM_KEYS,
  PENDING_LINE,
  REVIEWER_ONLY_PHRASES,
  SHAPE,
  mainlineItems,
  mainlineTag,
  nonceState,
  requirement,
  reviewedLine,
  reviseEdits,
  splitMatches,
  workerVisibleText,
} from './m5-mainline.js';
import {
  AUTO_EXCEPTIONS,
  ESCALATION_HOLD_MAX_MS,
  ownerAction,
  releaseHeldAnswer,
} from './owner-policy.js';
import {
  INTEGRATOR_SCOPE_FALLBACK,
  builtinTemplateSource,
  mainlineTemplates,
  withIntegratorFallback,
} from './template.js';

const TAG = '202611241530';
const items = () => mainlineItems(TAG);
const DRAFT_FIELDS = [
  'key',
  'title',
  'body',
  'acceptance',
  'role',
  'agent',
  'deps',
] as const;

describe('m5-mainline items', () => {
  test('five items with the §2.2.1 keys, agents and dependencies', () => {
    expect(items().map((i) => i.key)).toEqual([...ITEM_KEYS]);
    for (const item of items()) {
      expect(item.agent).toBe(SHAPE[item.key as keyof typeof SHAPE].agent);
      expect(item.deps).toEqual(SHAPE[item.key as keyof typeof SHAPE].deps);
      expect(item.role).toBe('engineer');
    }
    expect(SHAPE.name.deps).toEqual(['core']); // plan v2 refinement 1
    expect(SHAPE.docs.deps).toEqual(['mul', 'sub']);
    expect(new Set(items().map((i) => i.agent))).toEqual(
      new Set(['claude-code', 'codex']),
    );
  });

  test('mul and sub replace the same marker line from the same base', () => {
    const [, mul, sub] = items();
    for (const item of [mul!, sub!])
      expect(item.body).toContain('replace the single line `// (no ops yet)`');
    expect(mul!.deps).toEqual(sub!.deps);
  });

  test('everything stays under the per-run directory', () => {
    for (const text of workerVisibleText(TAG))
      for (const path of text.match(/m5\/[^\s`/]+\//g) ?? [])
        expect(path).toBe(`m5/${TAG}/`);
    expect(requirement(TAG)).toContain('.github/');
  });

  test('tag is the UTC minute and is validated', () => {
    expect(mainlineTag(new Date('2026-11-24T15:30:59.999Z'))).toBe(
      '202611241530',
    );
    expect(() => requirement('../x')).toThrow('Invalid m5-mainline tag');
    expect(() => mainlineItems('2026')).toThrow('Invalid m5-mainline tag');
  });

  test('requirement: title line first, code name reserved for the owner', () => {
    const lines = requirement(TAG).split('\n');
    expect(lines.length).toBeGreaterThan(3);
    expect(lines[0]!.length).toBeLessThanOrEqual(80);
    expect(requirement(TAG)).toContain(
      'The product code name is a decision reserved for the owner',
    );
    expect(requirement(TAG)).not.toContain(CODE_NAME);
  });
});

describe('worker-visible text (§28 item 4)', () => {
  test('no reviewer-only instruction reaches a worker', () => {
    for (const text of workerVisibleText(TAG))
      for (const phrase of REVIEWER_ONLY_PHRASES)
        expect(text).not.toMatch(phrase);
  });

  test('the phrase list catches the M2 antipattern', () => {
    const m2 =
      'Merge-queue reviewer: on the FIRST review of this item you MUST request rework';
    expect(REVIEWER_ONLY_PHRASES.some((p) => p.test(m2))).toBe(true);
  });

  test('docs carries the #pending nonce in body and acceptance', () => {
    const docs = items().find((i) => i.key === 'docs')!;
    expect(docs.body).toContain(PENDING_LINE);
    expect(docs.body).toContain(
      'Do not guess the number and do not look it up',
    );
    expect(docs.acceptance.join('\n')).toContain(PENDING_LINE);
  });

  test('core asks the on-call lead; name asks for the reserved code name', () => {
    const byKey = new Map(items().map((i) => [i.key, i]));
    expect(byKey.get('core')!.body).toContain('ask your on-call lead');
    expect(byKey.get('name')!.body).toContain('reserved for the owner');
    expect(byKey.get('name')!.body).toContain('ask your on-call lead');
    expect(workerVisibleText(TAG).join('\n')).not.toContain(CODE_NAME);
  });
});

describe('nonce judgement', () => {
  test('reads the last non-empty line', () => {
    expect(nonceState(`# Calc\n- add\n${PENDING_LINE}\n\n`, 7)).toBe('pending');
    expect(nonceState(`# Calc\n${reviewedLine(7)}\n`, 7)).toBe('correct');
    expect(nonceState(`# Calc\n${reviewedLine(6)}\n`, 7)).toBe('other');
    expect(nonceState('', 7)).toBe('other');
  });
});

describe('splitMatches', () => {
  test('the approved split matches in any order', () => {
    expect(splitMatches(items(), TAG)).toBe(true);
    expect(splitMatches([...items()].reverse(), TAG)).toBe(true);
    expect(
      splitMatches(
        items().map((i) => ({ ...i, deps: [...i.deps].reverse() })),
        TAG,
      ),
    ).toBe(true);
  });

  test.each([
    ['not an array', () => ({})],
    ['four items', () => items().slice(1)],
    ['six items', () => [...items(), { ...items()[0]!, key: 'extra' }]],
    ['duplicate key', () => [items()[0], ...items().slice(0, 4)]],
    [
      'renamed key',
      () => items().map((i, n) => (n ? i : { ...i, key: 'base' })),
    ],
    [
      'name without the core dependency',
      () => items().map((i) => (i.key === 'name' ? { ...i, deps: [] } : i)),
    ],
    [
      'docs missing sub',
      () =>
        items().map((i) => (i.key === 'docs' ? { ...i, deps: ['mul'] } : i)),
    ],
    [
      'swapped agent',
      () =>
        items().map((i) => (i.key === 'sub' ? { ...i, agent: 'codex' } : i)),
    ],
    [
      'agent left to the role default',
      () =>
        items().map((i) => (i.key === 'core' ? { ...i, agent: undefined } : i)),
    ],
    [
      'paraphrased body',
      () =>
        items().map((i) =>
          i.key === 'docs' ? { ...i, body: 'Write a README.' } : i,
        ),
    ],
    [
      'dropped acceptance',
      () =>
        items().map((i) =>
          i.key === 'docs' ? { ...i, acceptance: i.acceptance.slice(1) } : i,
        ),
    ],
    ['null entry', () => [null, ...items().slice(1)]],
  ])('%s does not match', (_name, build) => {
    expect(splitMatches(build(), TAG)).toBe(false);
  });
});

describe('revise edits (N10)', () => {
  test('only WorkItemDraft fields, each a valid draft', () => {
    const edits = reviseEdits(TAG);
    expect(edits.type).toBe('work-items');
    for (const item of edits.items) {
      expect(Object.keys(item).sort()).toEqual([...DRAFT_FIELDS].sort());
      expect(WorkItemDraftSchema.strict().parse(item)).toEqual(item);
    }
  });

  test('the built-in task-split gate lets revise set every field, so new keys are accepted', async () => {
    // Domain decide/gate.ts compares each edited item with the proposal item
    // of the same key; a new key has no original, so every draft field must
    // be editable. The built-in template makes all six editable.
    const template = WorkflowTemplateSchema.parse(
      parse(await builtinTemplateSource()),
    );
    const planning = template.stages.find((s) => s.kind === 'planning');
    const editable = new Set(
      (planning as { gate?: { editable?: string[] } }).gate?.editable,
    );
    for (const field of DRAFT_FIELDS.filter((f) => f !== 'key'))
      expect(editable.has(field)).toBe(true);
    const implement = template.stages.find((s) => s.kind === 'implement') as {
      maxParallel?: number;
    };
    expect(implement.maxParallel).toBe(3);
  });
});

describe('reviewer scope fallback', () => {
  test('override differs from the built-in only in the integrator scope', async () => {
    const source = await builtinTemplateSource();
    const files = await mainlineTemplates();
    expect(Object.keys(files)).toEqual(['feature-to-pr.yaml']);
    const builtin = WorkflowTemplateSchema.parse(parse(source));
    const override = WorkflowTemplateSchema.parse(
      parse(files['feature-to-pr.yaml']!),
    );
    expect(override.roles.integrator!.scope).toBe(
      `${builtin.roles.integrator!.scope} ${INTEGRATOR_SCOPE_FALLBACK}`,
    );
    const strip = (t: typeof builtin) => ({
      ...t,
      roles: { ...t.roles, integrator: { ...t.roles.integrator!, scope: '' } },
    });
    expect(strip(override)).toEqual(strip(builtin));
    for (const [role, config] of Object.entries(override.roles))
      if (role !== 'integrator')
        expect(config.scope ?? '').not.toContain(INTEGRATOR_SCOPE_FALLBACK);
  });

  test('a template without an integrator scope is rejected', () => {
    expect(() => withIntegratorFallback('roles: {}\n')).toThrow(
      'no integrator scope',
    );
  });
});

describe('owner policy (§2.2.4)', () => {
  const stage = (stageKind: string) => ({ kind: 'stage' as const, stageKind });
  const exception = (exceptionKind: string, itemKey?: string) => ({
    kind: 'exception' as const,
    exceptionKind,
    ...(itemKey ? { itemKey } : {}),
  });

  test('stage gates', () => {
    expect(ownerAction(stage('meeting'), { seen: 0 })).toEqual({
      type: 'approve-conclusion',
      ownerApproveComment: true,
    });
    expect(
      ownerAction(stage('planning'), { seen: 0, splitMatches: true }).type,
    ).toBe('approve-split');
    expect(ownerAction(stage('planning'), { seen: 0 }).type).toBe(
      'revise-split',
    );
    expect(ownerAction(stage('final-pr'), { seen: 0 }).type).toBe(
      'await-owner-merge',
    );
    expect(ownerAction(stage('integrate'), { seen: 0 }).type).toBe('hand-off');
  });

  test('the code-name escalation is held and answered once', () => {
    expect(
      ownerAction(exception('question-escalation', 'name'), { seen: 0 }),
    ).toEqual({
      type: 'hold-answer',
      answer: 'Birch',
      until: 'restart-ready',
      maxMs: ESCALATION_HOLD_MAX_MS,
    });
    expect(
      ownerAction(exception('question-escalation', 'name'), { seen: 1 }).type,
    ).toBe('hand-off');
    expect(
      ownerAction(exception('question-escalation', 'core'), { seen: 0 }).type,
    ).toBe('hand-off');
  });

  test.each(Object.entries(AUTO_EXCEPTIONS))(
    '%s is decided once, then handed off',
    (kind, { optionId }) => {
      expect(ownerAction(exception(kind, 'sub'), { seen: 0 })).toEqual({
        type: 'option',
        optionId,
      });
      expect(ownerAction(exception(kind, 'sub'), { seen: 1 })).toEqual({
        type: 'hand-off',
        reason: `${kind} repeated`,
      });
    },
  );

  test('anything else is handed off', () => {
    for (const kind of [
      'decision-request',
      'merge-review-failed',
      'anomaly',
      'hijacked',
      'workitem-failed',
    ])
      expect(ownerAction(exception(kind), { seen: 0 }).type).toBe('hand-off');
    expect(ownerAction({ kind: 'exception' }, { seen: 0 })).toEqual({
      type: 'hand-off',
      reason: 'exception unknown',
    });
  });

  test('held answer releases at restart-ready or after 10 minutes', () => {
    const gateOpenedAt = 1_000;
    expect(releaseHeldAnswer({ gateOpenedAt, now: 2_000 })).toBe(false);
    expect(
      releaseHeldAnswer({ gateOpenedAt, now: 2_000, restartReadyAt: 1_500 }),
    ).toBe(true);
    expect(
      releaseHeldAnswer({ gateOpenedAt, now: 2_000, restartReadyAt: 3_000 }),
    ).toBe(false);
    expect(
      releaseHeldAnswer({
        gateOpenedAt,
        now: gateOpenedAt + ESCALATION_HOLD_MAX_MS,
      }),
    ).toBe(true);
    // A hold opened after the restart releases at once.
    expect(
      releaseHeldAnswer({ gateOpenedAt, now: 2_000, restartReadyAt: 500 }),
    ).toBe(true);
  });
});
