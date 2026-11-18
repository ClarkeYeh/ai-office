import { replay } from '@ai-office/projection';
import { describe, expect, test } from 'vitest';
import { mainline } from '../../../test-support/office/mainline.js';
import {
  CONCLUSION,
  EDITED,
  renderConclusion,
  withMarker,
} from '../test-support/conclusion.js';
import {
  conclusionFromDraft,
  conclusionViewModel,
  draftFromConclusion,
  emptyTechDraft,
  parseConclusionBody,
  stripMarker,
} from './conclusion.js';
import type { GateView } from './gateHeader.js';

const log = mainline();
const model = log.at('gate:conclusion');
const base = model.gates.find((g) => g.gateId === 'g-conclusion')!;
const gate = (conclusion: Partial<NonNullable<GateView['conclusion']>>) =>
  ({
    ...base,
    conclusion: { ...base.conclusion!, ...conclusion },
  }) as GateView;
void replay;

describe('marker and body parsing', () => {
  test('strips the command marker only', () => {
    const body = renderConclusion(CONCLUSION);
    expect(stripMarker(withMarker(body))).toBe(body);
    expect(stripMarker(body)).toBe(body);
  });
  test('parses the engine sections back into a conclusion', () => {
    expect(parseConclusionBody(withMarker(renderConclusion(EDITED)))).toEqual(
      EDITED,
    );
    expect(
      parseConclusionBody(renderConclusion(CONCLUSION).replace(/\n/g, '\r\n')),
    ).toEqual(CONCLUSION);
  });
  test.each([
    [
      'missing section',
      (b: string) => b.replace(/<!-- ai-office:summary:start -->/, ''),
    ],
    ['bad JSON', (b: string) => b.replace('"Use CSS', '{"Use CSS')],
    [
      'wrong summary type',
      (b: string) => b.replace(/"Use CSS variables and a ThemeProvider"/, '42'),
    ],
    [
      'wrong decision shape',
      (b: string) =>
        b.replace('"rationale": "no per-component colours"', '"rationale": 1'),
    ],
    [
      'wrong options type',
      (b: string) => b.replace(/"options": \[[^\]]*\]/, '"options": "x"'),
    ],
    [
      'wrong questions',
      (b: string) => b.replace('"Add a third option?"', 'null'),
    ],
    [
      'decision not an object',
      (b: string) =>
        b.replace(/"decisions": \[|## decisions\n\[/, '## decisions\n[1,'),
    ],
  ])('returns null for %s', (_, mutate) => {
    expect(
      parseConclusionBody(mutate(renderConclusion(CONCLUSION))),
    ).toBeNull();
  });
});

describe('conclusionViewModel', () => {
  const rendered = renderConclusion(CONCLUSION);
  test('three views and a diff where GitHub added a decision', () => {
    const vm = conclusionViewModel(
      gate({
        original: CONCLUSION,
        renderedBody: rendered,
        githubBody: withMarker(renderConclusion(EDITED)),
        changedOnGithub: true,
      }),
      model,
    );
    expect(vm.github).toEqual({ kind: 'structured', conclusion: EDITED });
    expect(vm.original).toEqual({ kind: 'structured', conclusion: CONCLUSION });
    expect(vm.changedOnGithub).toBe(true);
    expect(vm.diff.kind).toBe('lines');
    if (vm.diff.kind === 'lines') {
      const added = vm.diff.lines.filter((l) => l.kind === 'added');
      expect(added.map((l) => l.text).join('\n')).toContain(
        'Apply saved theme before first paint',
      );
      // The marker never reaches the diff.
      expect(vm.diff.lines.some((l) => l.text.includes('ai-office:cmd'))).toBe(
        false,
      );
    }
    expect(vm.editBase).toEqual({ source: 'github', conclusion: EDITED });
    expect(vm.issue).toEqual({
      number: 1,
      url: 'https://github.com/octo/demo/issues/1',
    });
    expect(vm.round).toBe(2);
    expect(vm.statements.map((s) => s.role)).toEqual([
      'pm',
      'architect',
      'engineer',
    ]);
  });
  test('missing GitHub body: diff unavailable, revise starts from the original', () => {
    const vm = conclusionViewModel(
      gate({ original: CONCLUSION, renderedBody: rendered }),
      null,
    );
    expect(vm.github).toEqual({ kind: 'unavailable' });
    expect(vm.diff).toEqual({ kind: 'unavailable' });
    expect(vm.editBase).toEqual({ source: 'original', conclusion: CONCLUSION });
    expect(vm.issue).toBeNull();
    expect(vm.round).toBeNull();
    expect(vm.statements).toEqual([]);
  });
  test('missing rendered body (revised or hash mismatch): diff unavailable', () => {
    const vm = conclusionViewModel(
      gate({ original: null, githubBody: 'edited by hand' }),
      model,
    );
    expect(vm.github).toEqual({ kind: 'raw', text: 'edited by hand' });
    expect(vm.original).toEqual({ kind: 'unavailable' });
    expect(vm.diff).toEqual({ kind: 'unavailable' });
    expect(vm.editBase).toBeNull();
  });
  test('unstructured original falls back to the rendered text; no conclusion view at all', () => {
    expect(
      conclusionViewModel(gate({ original: null, renderedBody: 'text' }), null)
        .original,
    ).toEqual({ kind: 'raw', text: 'text' });
    const bare = conclusionViewModel(
      { ...base, conclusion: undefined } as GateView,
      null,
    );
    expect(bare.changedOnGithub).toBe(false);
    expect(bare.github.kind).toBe('unavailable');
  });
});

describe('revise draft', () => {
  test('round-trips a conclusion', () => {
    expect(conclusionFromDraft(draftFromConclusion(EDITED))).toEqual(EDITED);
  });
  test('normalises lines, separators and blank tech rows', () => {
    expect(
      conclusionFromDraft({
        summary: '  s ',
        decisions: 'A｜because\n\n B ',
        openQuestions: 'q1\n \nq2',
        techDecisions: [
          { topic: 'T', options: 'x、y, z，w', chosen: 'x', rationale: ' r ' },
          emptyTechDraft(),
        ],
      }),
    ).toEqual({
      summary: 's',
      decisions: [
        { title: 'A', rationale: 'because' },
        { title: 'B', rationale: '' },
      ],
      techDecisions: [
        {
          topic: 'T',
          options: ['x', 'y', 'z', 'w'],
          chosen: 'x',
          rationale: 'r',
        },
      ],
      openQuestions: ['q1', 'q2'],
    });
  });
});
