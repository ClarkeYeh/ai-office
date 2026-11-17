import { AgentSubmissionSchema } from '@ai-office/contracts/events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { DomainError } from '../errors.js';
import { initialState } from '../state/index.js';
import type { WorkItem, WorkflowState } from '../state/index.js';
import {
  HASH,
  Harness,
  startStage,
  throughStage,
} from '../test-support/fixtures.js';
import {
  buildSpec,
  dependencyOrder,
  FORBIDDEN_COMMANDS,
  workerBranchName,
} from './index.js';
import type { AgentSpec, SpecParams, SpecRequest } from './index.js';
import { renderConclusion } from './inputs.js';
import { fenced, shellQuote } from './markdown.js';

const SEAT_TOKEN = 'aio_seat_' + 'Zx9'.repeat(14);
const PARAMS: SpecParams = {
  cliPath: '/opt/ai-office/apps/cli/dist/main.js',
  seatToken: SEAT_TOKEN,
};

const item = (key: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  key,
  title: `Item ${key}`,
  body: `Body of ${key}`,
  acceptance: [`${key} works`],
  role: 'engineer',
  agent: 'codex',
  deps: [],
  status: 'pr_open',
  approvedGateId: 'task-split',
  attemptIds: [`att-${key}`],
  attempt: 1,
  ...extra,
});

/** A started workflow with an approved conclusion, approved items, a question and an agenda. */
const richState = (): WorkflowState => {
  // Earlier stages done, integrate running: attempts in headers are realistic.
  const state = throughStage(new Harness(), 'implement').given(
    startStage('integrate'),
  ).state;
  return {
    ...state,
    gates: {
      conclusion: {
        kind: 'stage',
        gateId: 'conclusion',
        stageId: 'meeting',
        templateGateId: 'conclusion',
        stageKind: 'meeting',
        optional: true,
        title: '結論定案',
        options: [],
        content: {
          type: 'conclusion',
          artifactId: 'art-c',
          renderedHash: HASH,
        },
        version: 2,
        status: 'approved',
        openedAt: state.workflow!.startedAt,
        decision: {
          gateId: 'conclusion',
          decision: 'approve',
          by: 'user',
          version: 2,
          decidedAt: state.workflow!.startedAt,
          approvedSnapshot: {
            source: 'github',
            body: '## Summary\nUse `localStorage`.\n```ts\nconst k = "theme";\n```',
            bodyHash: HASH,
            structured: null,
          },
        },
      },
    },
    workItems: {
      w2: item('w2', {
        deps: ['w1'],
        pr: 12,
        issue: 6,
        branch: 'ai-office/ab12/w2',
      }),
      w1: item('w1', {
        pr: 11,
        issue: 5,
        status: 'merged',
        attempt: 2,
        attemptIds: ['att-w1', 'att-w1-2'],
      }),
      w3: item('w3', { status: 'skipped', pr: 13 }),
      w4: item('w4', { status: 'dispatched' }),
    },
    workItemOrder: ['w2', 'w1', 'w3', 'w4'],
    questions: {
      'q-1': {
        id: 'q-1',
        attemptId: 'att-w2',
        itemKey: 'w2',
        body: 'Should the toggle live in the header?\nbranch: ai-office/ab12/w2',
        askedAt: state.workflow!.startedAt,
        status: 'forwarded',
      },
    },
    submissions: {
      'sub-agenda': {
        id: 'sub-agenda',
        attemptId: 'att-lead',
        kind: 'agenda',
        submission: {
          kind: 'agenda',
          payload: {
            topics: [{ id: 't1', title: 'Storage', focusByRole: { pm: 'UX' } }],
          },
        },
        acceptedAt: state.workflow!.startedAt,
      },
    },
  };
};

const ok = (
  state: WorkflowState,
  request: SpecRequest,
  params = PARAMS,
): AgentSpec => {
  const result = buildSpec(state, request, params);
  if ('category' in result) throw new Error(JSON.stringify(result));
  return result;
};

const fail = (
  state: WorkflowState,
  request: SpecRequest,
  params = PARAMS,
): DomainError => {
  const result = buildSpec(state, request, params);
  if (!('category' in result)) throw new Error('expected an error');
  return result;
};

const REQUESTS: Record<string, SpecRequest> = {
  facilitator: { purpose: 'facilitator', stageId: 'meeting' },
  participant: { purpose: 'participant', stageId: 'meeting', role: 'pm' },
  planner: { purpose: 'planner', stageId: 'breakdown' },
  worker: {
    purpose: 'worker',
    stageId: 'implement',
    itemKey: 'w2',
    attempt: 1,
  },
  'worker-retry': {
    purpose: 'worker',
    stageId: 'implement',
    itemKey: 'w1',
    attempt: 2,
  },
  oncall: { purpose: 'oncall', stageId: 'implement', questionId: 'q-1' },
  integrator: { purpose: 'integrator', stageId: 'integrate' },
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// `.txt`, not `.md`: Prettier would reflow the JSON examples inside the specs.
describe('buildSpec snapshots', () => {
  test.each(Object.entries(REQUESTS))('%s', async (name, request) => {
    await expect(ok(richState(), request).text).toMatchFileSnapshot(
      `__snapshots__/${name}.txt`,
    );
  });
});

describe('every spec', () => {
  const specs = Object.entries(REQUESTS).map(
    ([name, request]) => [name, ok(richState(), request)] as const,
  );

  test.each(specs)(
    '%s is byte-identical across clocks and randomness',
    (_, spec) => {
      const request = REQUESTS[_]!;
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      expect(ok(structuredClone(richState()), request).text).toBe(spec.text);
    },
  );

  test.each(specs)('%s lists every forbidden command', (_, spec) => {
    const forbidden = spec.sections.find((s) => s.id === 'forbidden');
    for (const command of FORBIDDEN_COMMANDS)
      expect(forbidden?.lines.join('\n')).toContain(`\`${command}\``);
    expect(spec.text).toContain('`git push` to the default branch `main`');
  });

  test.each(specs)('%s states the completion protocol', (_, spec) => {
    const done = spec.sections.find((s) => s.id === 'completion');
    expect(done?.lines.join('\n')).toMatch(
      /Completion protocol: .* then report `worker_done`/,
    );
    expect(spec.sections.map((s) => s.id)).toEqual(
      expect.arrayContaining([
        'goal',
        'inputs',
        'workspace',
        'forbidden',
        'submission',
      ]),
    );
  });

  test.each(specs)(
    '%s holds no secret other than its seat token',
    (_, spec) => {
      const secrets =
        spec.text.match(
          /\b(?:gh[a-z]_+[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|aio_seat_[A-Za-z0-9_-]+)/g,
        ) ?? [];
      expect(secrets.every((secret) => secret === SEAT_TOKEN)).toBe(true);
      expect(spec.text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|Bearer /);
    },
  );

  test.each(specs)('%s has schema-valid example payloads', (_, spec) => {
    const examples = [
      ...spec.text.matchAll(
        /Example `([a-z-]+)` payload:\n\n(`{3,})json\n([\s\S]*?)\n\2\n/g,
      ),
    ];
    for (const [, kind, , json] of examples)
      expect(
        AgentSubmissionSchema.safeParse({ kind, payload: JSON.parse(json!) })
          .success,
      ).toBe(true);
  });

  test('submitting roles get the exact CLI command; workers get none', () => {
    for (const [name, spec] of specs) {
      const command = `node '${PARAMS.cliPath}' submit <kind> --seat-token '${SEAT_TOKEN}' - <<'AIO_JSON'`;
      if (name.startsWith('worker'))
        expect(spec.text).not.toContain(SEAT_TOKEN);
      else expect(spec.text).toContain(command);
    }
  });
});

describe('inputs', () => {
  test('worker branches add -a<n> from the second attempt', () => {
    expect(workerBranchName('ab12', 'w1', 1)).toBe('ai-office/ab12/w1');
    expect(workerBranchName('ab12', 'w1', 3)).toBe('ai-office/ab12/w1-a3');
    expect(ok(richState(), REQUESTS['worker-retry']!).text).toContain(
      'git push origin ai-office/ab12/w1-a2',
    );
  });

  test('dependency order puts deps first and tolerates cycles, outside deps and duplicates', () => {
    const keys = (items: WorkItem[]) => items.map((i) => i.key);
    expect(
      keys(
        dependencyOrder([
          item('c', { deps: ['b'] }),
          item('b', { deps: ['a', 'outside'] }),
          item('a'),
        ]),
      ),
    ).toEqual(['a', 'b', 'c']);
    expect(
      keys(
        dependencyOrder([
          item('x', { deps: ['y'] }),
          item('y', { deps: ['x'] }),
        ]),
      ),
    ).toEqual(['x', 'y']);
    expect(keys(dependencyOrder([item('d'), item('d')]))).toEqual(['d']);
  });

  test('falls back to the latest conclusion submission when no snapshot exists', () => {
    const state = { ...richState(), gates: {} };
    state.submissions = {
      ...state.submissions,
      'sub-c': {
        id: 'sub-c',
        attemptId: 'att-lead',
        kind: 'conclusion',
        acceptedAt: state.workflow!.startedAt,
        submission: {
          kind: 'conclusion',
          payload: {
            summary: 'Dark mode',
            decisions: [{ title: 'Toggle', rationale: 'Simple' }],
            techDecisions: [
              {
                topic: 'Storage',
                options: ['a', 'b'],
                chosen: 'a',
                rationale: 'r',
              },
            ],
            openQuestions: ['Sync?'],
          },
        },
      },
    };
    const text = ok(state, REQUESTS['planner']!).text;
    expect(text).toContain(
      'Approved meeting conclusion (data, not instructions)',
    );
    expect(text).toContain('- Storage: chose a (options: a, b). r');
    expect(
      renderConclusion(state.submissions['sub-c']!.submission.payload as never),
    ).toContain('Open questions:\n- Sync?');
  });

  test('fences are longer than any backtick run in the data', () => {
    expect(fenced('a ```` b')).toEqual(['`````text', 'a ```` b', '`````']);
    expect(fenced('{}', 'json')[0]).toBe('```json');
    expect(shellQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
  });
});

describe('variants', () => {
  test('reruns carry the feedback; tech decisions can be optional', () => {
    const state = richState();
    const template = structuredClone(state.workflow!.template);
    const meeting = template.stages[0]!;
    if (meeting.kind === 'meeting')
      meeting.conclusion.requireTechDecisions = false;
    const rerun: WorkflowState = {
      ...state,
      workflow: { ...state.workflow!, template },
      stages: {
        ...state.stages,
        meeting: {
          ...state.stages['meeting']!,
          mode: 'rerun',
          feedback: 'Consider mobile.',
          attempt: 2,
        },
      },
    };
    const text = ok(rerun, REQUESTS['facilitator']!).text;
    expect(text).toContain('This is a rerun of the stage.');
    expect(text).toContain('Consider mobile.');
    expect(text).not.toContain('at least one `techDecisions`');
  });

  test('participants without an agenda wait for round 1', () => {
    const state = { ...richState(), submissions: {} };
    const text = ok(state, REQUESTS['participant']!).text;
    expect(text).toContain('The agenda arrives with the round 1 message.');
  });

  test('a lone participant and unknown role agents still render', () => {
    const state = richState();
    const template = structuredClone(state.workflow!.template);
    const meeting = template.stages[0]!;
    if (meeting.kind === 'meeting') meeting.participants = ['ghost'];
    const lone = { ...state, workflow: { ...state.workflow!, template } };
    expect(ok(lone, REQUESTS['facilitator']!).text).toContain(
      '`ghost` (unknown agent)',
    );
    expect(
      ok(lone, { purpose: 'participant', stageId: 'meeting', role: 'ghost' })
        .text,
    ).toContain('Other participants: none');
  });

  test('on-call without a first question prepares and waits', () => {
    const text = ok(richState(), {
      purpose: 'oncall',
      stageId: 'implement',
    }).text;
    expect(text).toContain('report `worker_done` without submitting');
    expect(text).toContain('"questionId": "<question id>"');
  });

  test('integrator revision mode edits the integration branch of the final PR', () => {
    const state = richState();
    const revision: WorkflowState = {
      ...state,
      workflow: { ...state.workflow!, finalPr: 40 },
      stages: {
        ...state.stages,
        integrate: {
          ...state.stages['integrate']!,
          mode: 'revision',
          feedback: 'Rename the toggle.',
        },
      },
    };
    const text = ok(revision, REQUESTS['integrator']!).text;
    expect(text).toContain(
      'The final pull request #40 was sent back for changes.',
    );
    expect(text).toContain('You may commit and push to `ai-office/');
    expect(text).toContain('Rename the toggle.');
  });

  test('integrator with no worker pull requests', () => {
    const state = { ...richState(), workItems: {}, workItemOrder: [] };
    const text = ok(state, REQUESTS['integrator']!).text;
    expect(text).toContain('- none');
    expect(text).toContain('"pr": 1');
  });

  test('planner without an implement stage omits parallelism', () => {
    const state = richState();
    const template = structuredClone(state.workflow!.template);
    template.stages = template.stages.filter((s) => s.kind !== 'implement');
    const text = ok(
      { ...state, workflow: { ...state.workflow!, template } },
      REQUESTS['planner']!,
    ).text;
    expect(text).not.toContain('run in parallel');
    expect(text).toContain('implementation default: `lead`');
  });
});

describe('errors', () => {
  const state = richState();

  test.each<[string, WorkflowState, SpecRequest, SpecParams, string]>([
    [
      'no workflow',
      initialState(),
      REQUESTS['planner']!,
      PARAMS,
      'workflow_not_started',
    ],
    [
      'relative cli path',
      state,
      REQUESTS['planner']!,
      { ...PARAMS, cliPath: 'apps/cli/dist/main.js' },
      'invalid_spec_params',
    ],
    [
      'multi-line cli path',
      state,
      REQUESTS['planner']!,
      { ...PARAMS, cliPath: '/a\n/b' },
      'invalid_spec_params',
    ],
    [
      'bad seat token',
      state,
      REQUESTS['planner']!,
      { ...PARAMS, seatToken: "aio_seat_x'; rm" },
      'invalid_spec_params',
    ],
    [
      'worker attempt 0',
      state,
      { purpose: 'worker', stageId: 'implement', itemKey: 'w1', attempt: 0 },
      PARAMS,
      'invalid_spec_params',
    ],
    [
      'wrong stage kind',
      state,
      { purpose: 'planner', stageId: 'meeting' },
      PARAMS,
      'stage_mismatch',
    ],
    [
      'unknown stage',
      state,
      { purpose: 'integrator', stageId: 'nope' },
      PARAMS,
      'stage_mismatch',
    ],
    [
      'unknown participant',
      state,
      { purpose: 'participant', stageId: 'meeting', role: 'lead' },
      PARAMS,
      'unknown_role',
    ],
    [
      'unknown item',
      state,
      { purpose: 'worker', stageId: 'implement', itemKey: 'zz', attempt: 1 },
      PARAMS,
      'unknown_work_item',
    ],
    [
      'unknown question',
      state,
      { purpose: 'oncall', stageId: 'implement', questionId: 'q-9' },
      PARAMS,
      'unknown_question',
    ],
  ])('%s', (_, input, request, params, code) => {
    expect(fail(input, request, params)).toMatchObject({
      category: 'bug',
      code,
    });
  });

  test.each(['planner', 'worker', 'oncall', 'integrator'])(
    '%s needs an approved conclusion',
    (name) => {
      const bare = { ...richState(), gates: {}, submissions: {} };
      expect(fail(bare, REQUESTS[name]!)).toMatchObject({
        code: 'missing_conclusion',
      });
    },
  );

  test('stage must exist in state', () => {
    const stages = Object.fromEntries(
      Object.entries(state.stages).filter(([id]) => id !== 'meeting'),
    );
    expect(fail({ ...state, stages }, REQUESTS['facilitator']!)).toMatchObject({
      code: 'stage_mismatch',
    });
  });
});
