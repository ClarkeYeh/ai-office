import { parse } from 'yaml';
import { describe, expect, test } from 'vitest';
import { ITEMS, TEST_TEMPLATE } from '../../orca/t17/implement-scenario.js';
import { mainlineRun } from './binding.js';
import { PENDING_LINE, REVIEWER_ONLY_PHRASES } from './m5-mainline.js';
import { INTEGRATOR_SCOPE_FALLBACK } from './template.js';

describe('M2 implement scenario rework (§28 item 4)', () => {
  test('worker-visible item text has no reviewer-only instruction', () => {
    for (const item of ITEMS)
      for (const text of [item.title, item.body, ...item.acceptance])
        for (const phrase of REVIEWER_ONLY_PHRASES)
          expect(text).not.toMatch(phrase);
  });

  test('farewell uses the PR-number nonce', () => {
    const farewell = ITEMS.find((i) => i.key === 'farewell')!;
    expect(farewell.body).toContain(PENDING_LINE);
    expect(farewell.body).toContain(
      'Do not guess the number and do not look it up',
    );
    expect(farewell.acceptance.join('\n')).toContain(PENDING_LINE);
  });

  test('only the integrator scope carries the fallback', () => {
    const lines = TEST_TEMPLATE.split('\n').filter((l) =>
      l.includes(INTEGRATOR_SCOPE_FALLBACK),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\s+integrator:/);
  });
});

describe('m5-mainline bindings', () => {
  test.each([
    ['github', 'github-body-hash', 'owner-by-hand'],
    ['gitremote', 'in-memory', 'double-explicit'],
  ] as const)('%s', async (world, conclusion, finalPrMerge) => {
    const run = await mainlineRun(world, new Date('2026-11-24T15:30:00Z'));
    expect(run).toMatchObject({
      world,
      tag: '202611241530',
      templateId: 'feature-to-pr',
      enforcement: 'off',
      conclusion,
      finalPrMerge,
    });
    expect(run.requirement).toContain('m5/202611241530/');
    const template = parse(run.templates['feature-to-pr.yaml']!) as {
      roles: Record<string, { scope?: string }>;
    };
    expect(template.roles.integrator!.scope).toContain(
      INTEGRATOR_SCOPE_FALLBACK,
    );
  });
});
