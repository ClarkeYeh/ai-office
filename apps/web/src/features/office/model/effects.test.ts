import { describe, expect, it } from 'vitest';
import {
  DomainEventSchema,
  type DomainEvent,
} from '@ai-office/contracts/events';
import { evolve, type ReadModel } from '@ai-office/projection';
import { effects } from './effects.js';
import type { Anchor, Effect } from './effect-types.js';

const at = '2026-11-18T00:00:00Z';
const event = (type: string, payload: unknown): DomainEvent =>
  DomainEventSchema.parse({
    seq: 2,
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    occurredAt: at,
    recordedAt: at,
    workflowId: 'wf',
    source: 'engine',
    provenance: 'decided',
    schemaVersion: 1,
    type,
    payload,
  });
const spawn = (attemptId = 'worker', stageId = 'implement') =>
  event('seat.spawned', {
    seatId: attemptId,
    attemptId,
    attempt: 1,
    stageId,
    role: 'engineer',
    agent: 'codex',
    purpose: 'worker',
    keepOpen: false,
    spawnCommandId: 'spawn',
  });
function model(): ReadModel {
  let rm = evolve(
    null,
    event('workflow.started', {
      templateSnapshot: {
        apiVersion: 'ai-office/v1alpha1',
        id: 'flow',
        name: 'Flow',
        roles: { engineer: { agent: 'codex' } },
        defaults: {
          integrationBranch: 'ai-office/{shortId}-{slug}',
          maxReruns: 2,
          budget: { hardLimitMultiplier: 2 },
        },
        stages: [
          {
            id: 'meeting',
            kind: 'meeting',
            facilitator: 'engineer',
            participants: ['engineer'],
            maxRounds: 2,
            timeouts: { roundMin: 15, stageMin: 60 },
            budget: { tokens: 1000 },
            conclusion: { requireTechDecisions: true },
            gate: { id: 'conclusion', title: 'Conclusion' },
          },
          {
            id: 'planning',
            kind: 'planning',
            owner: 'engineer',
            from: 'meeting',
            timeouts: { stageMin: 30 },
            budget: { tokens: 1000 },
            gate: { id: 'plan', title: 'Plan' },
          },
          {
            id: 'implement',
            kind: 'implement',
            role: 'engineer',
            from: 'planning',
            maxParallel: 3,
            timeouts: { itemMin: 30 },
            budget: { tokens: 1000 },
            onCall: { role: 'engineer', questionTimeoutMin: 10 },
            mergeQueue: { role: 'engineer', reviewTimeoutMin: 10 },
            escalateOn: [],
          },
          {
            id: 'integrate',
            kind: 'integrate',
            owner: 'engineer',
            timeouts: { stageMin: 60 },
            budget: { tokens: 1000 },
          },
          {
            id: 'final-pr',
            kind: 'final-pr',
            maxRevisions: 2,
            gate: { id: 'final', title: 'Final PR' },
          },
        ],
      },
      repo: {
        repoId: 'repo',
        localPath: '/repo',
        orcaRepoId: 'repo',
        github: { owner: 'test', name: 'test' },
        defaultBranch: 'main',
        visibility: 'public',
        ownerLogin: 'test',
        defaultBranchProtected: 'unknown',
      },
      requirement: 'Test effects',
      shortId: 'test',
      integrationBranch: 'ai-office/test',
      roleOverrides: {},
      gateToggles: {},
      budgets: { stages: {}, hardLimitMultiplier: 2 },
      limits: { globalAgents: 10 },
      acknowledgedUnverifiedRuntime: false,
    }),
  )!;
  for (const id of ['worker', 'lead'])
    rm = evolve(rm, { ...spawn(id), seq: rm.lastSeq + 1 })!;
  rm.questions.push({
    questionId: 'q',
    workflowId: 'wf',
    attemptId: 'worker',
    seatId: 'worker',
    role: 'engineer',
    body: 'Question',
    status: 'forwarded',
    askedAt: at,
  });
  rm.workItems.push({
    key: 'A',
    title: 'A',
    body: 'A',
    acceptance: ['A'],
    role: 'engineer',
    deps: [],
    status: 'merge_queued',
    attempts: 1,
    reworks: 0,
    usage: { ...rm.seats[0]!.usage },
  });
  return rm;
}
const seat: Anchor = { kind: 'seat', seatId: 'worker' };
const lead: Anchor = { kind: 'seat', seatId: 'lead' };
const inbox: Anchor = { kind: 'inbox' };
const desk: Anchor = { kind: 'your-desk' };
const counter: Anchor = { kind: 'counter' };
const item: Anchor = { kind: 'workitem', itemKey: 'A' };
const conveyor: Anchor = { kind: 'conveyor' };
const envelope = (...route: [Anchor, Anchor, ...Anchor[]]): Effect => ({
  kind: 'envelope',
  route,
  reducedMotion: { kind: 'flash-nameplate', at: route.at(-1)! },
});
const parcel: Effect = {
  kind: 'parcel-to-counter',
  itemKey: 'A',
  from: conveyor,
  to: counter,
};

describe('M4 design §3.3 transient effects', () => {
  const cases: [string, DomainEvent, Effect[]][] = [
    [
      'walk in',
      spawn(),
      [
        {
          kind: 'walk-in',
          attemptId: 'worker',
          from: { kind: 'entrance' },
          to: seat,
        },
      ],
    ],
    [
      'walk to meeting',
      spawn('worker', 'meeting'),
      [
        {
          kind: 'walk-to-meeting',
          attemptId: 'worker',
          from: { kind: 'entrance' },
          to: { kind: 'meeting', seatId: 'worker' },
        },
      ],
    ],
    ...(['seat.exited', 'seat.released'] as const).map(
      (type): [string, DomainEvent, Effect[]] => [
        type,
        event(
          type,
          type === 'seat.exited'
            ? { attemptId: 'worker', reason: 'done', expected: true }
            : { attemptId: 'worker', removeWorkspace: false },
        ),
        [
          {
            kind: 'walk-out',
            attemptId: 'worker',
            from: seat,
            to: { kind: 'entrance' },
          },
        ],
      ],
    ),
    [
      'print worker PR',
      event('artifact.created', {
        kind: 'pr',
        purpose: 'worker',
        head: 'feature',
        base: 'integration',
        artifactId: 'pr',
        repo: { owner: 'test', name: 'test' },
        number: 1,
        url: 'https://example.com/pr/1',
        itemKey: 'A',
      }),
      [{ kind: 'print', artifactId: 'pr', at: { kind: 'printer' } }],
    ],
    [
      'print final PR',
      event('artifact.created', {
        kind: 'pr',
        purpose: 'final',
        head: 'feature',
        base: 'integration',
        artifactId: 'pr',
        repo: { owner: 'test', name: 'test' },
        number: 1,
        url: 'https://example.com/pr/1',
      }),
      [{ kind: 'print', artifactId: 'pr', at: { kind: 'printer' } }],
    ],
    [
      'queue parcel',
      event('workitem.merge_queued', {
        itemKey: 'A',
        attemptId: 'worker',
        pr: 1,
        headSha: 'abcdef1',
      }),
      [{ kind: 'conveyor', itemKey: 'A', from: item, to: conveyor }],
    ],
    [
      'review parcel',
      event('workitem.status', { itemKey: 'A', status: 'in_review' }),
      [parcel],
    ],
    [
      'return parcel',
      event('workitem.rework_requested', {
        itemKey: 'A',
        pr: 1,
        submissionId: 's',
        attemptId: 'lead',
        reasons: ['fix'],
        rework: 1,
      }),
      [{ kind: 'parcel-return', itemKey: 'A', from: counter, to: item }],
    ],
    [
      'merge and confetti',
      event('workitem.merged', {
        itemKey: 'A',
        pr: 1,
        mergeCommitSha: 'abcdef1',
        commandId: 'c',
      }),
      [
        {
          kind: 'merge',
          itemKey: 'A',
          from: counter,
          to: { kind: 'integration-cart' },
          confetti: true,
        },
      ],
    ],
    [
      'door and confetti',
      event('gate.closed', { gateId: 'final', reason: 'merged' }),
      [{ kind: 'door-open', at: { kind: 'main-door' }, confetti: true }],
    ],
  ];
  it.each(cases)('%s', (_name, e, expected) => {
    const rm = model();
    expect(effects(e, rm, rm)).toEqual(expected);
  });

  it.each([
    [
      'dispatch',
      event('workitem.dispatched', {
        itemKey: 'A',
        attemptId: 'worker',
        attempt: 1,
        agent: 'codex',
        branch: 'ai-office/test/A',
        workspaceName: 'A',
      }),
      [inbox, item],
    ],
    [
      'question',
      event('message.question', {
        questionId: 'q',
        attemptId: 'worker',
        body: 'Question',
      }),
      [seat, inbox],
    ],
    [
      'forward',
      event('message.forwarded', {
        questionId: 'q',
        to: 'on-call',
        toAttemptId: 'lead',
        retry: 0,
      }),
      [inbox, lead],
    ],
    [
      'agent answer',
      event('message.answered', {
        questionId: 'q',
        by: 'agent',
        attemptId: 'lead',
        body: 'Answer',
      }),
      [lead, inbox, seat],
    ],
    [
      'user answer',
      event('message.answered', {
        questionId: 'q',
        by: 'user',
        body: 'Answer',
      }),
      [desk, inbox, seat],
    ],
    [
      'escalate',
      event('message.escalated', {
        questionId: 'q',
        reason: 'timeout',
        gateId: 'gate',
      }),
      [inbox, desk],
    ],
    [
      'instruction',
      event('message.instruction', {
        seatId: 'worker',
        attemptId: 'worker',
        subject: 'Instruction',
        body: 'Instruction',
      }),
      [desk, inbox, seat],
    ],
    [
      'nudge',
      event('message.nudge', {
        attemptId: 'worker',
        subject: 'Nudge',
        body: 'Nudge',
        reason: 'missing-submission',
      }),
      [inbox, seat],
    ],
  ] as [string, DomainEvent, [Anchor, Anchor, ...Anchor[]]][])(
    'envelope: %s',
    (_name, e, route) => {
      const rm = model();
      expect(effects(e, rm, rm)).toEqual([envelope(...route)]);
    },
  );

  it('merge current change moves the parcel and delivers an envelope', () => {
    const rm = model();
    const e = event('ondemand.queue_changed', {
      stageId: 'implement',
      purpose: 'merge',
      current: 'A',
      queue: [],
    });
    expect(effects(e, rm, rm)).toEqual([parcel, envelope(inbox, counter)]);
    rm.workItems[0]!.status = 'in_review';
    expect(effects(e, rm, rm)).toEqual([envelope(inbox, counter)]);
    rm.stages[2]!.ondemand!.merge!.current = 'A';
    expect(effects(e, rm, rm)).toEqual([]);
  });
  it.each([{ purpose: 'oncall', current: 'q' }, { purpose: 'merge' }])(
    'ignores queue-only changes: %j',
    (payload) => {
      const rm = model();
      expect(
        effects(
          event('ondemand.queue_changed', {
            stageId: 'implement',
            queue: [],
            ...payload,
          }),
          rm,
          rm,
        ),
      ).toEqual([]);
    },
  );
  it.each([
    [0, 1, 0, 1],
    [1, 50_001, 1, 2],
    [50_001, 50_002, 2, 2],
    [600_000, 700_000, 12, 12],
  ])('paper growth %i → %i', (before, after, fromSheets, toSheets) => {
    const prev = model(),
      next = model();
    prev.seats[0]!.usage.budgetTokens = before;
    next.seats[0]!.usage.budgetTokens = after;
    expect(
      effects(
        event('usage.tokens', {
          attemptId: 'worker',
          inputUncached: 1,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          budgetTokens: 1,
        }),
        prev,
        next,
      ),
    ).toEqual([{ kind: 'paper-grow', at: seat, fromSheets, toSheets }]);
  });
  it.each([0, -1])(
    'does not grow on unchanged/decreased seat usage (%i)',
    (delta) => {
      const prev = model(),
        next = model();
      prev.seats[0]!.usage.budgetTokens = 10;
      next.seats[0]!.usage.budgetTokens = 10 + delta;
      expect(
        effects(
          event('usage.tokens', {
            attemptId: 'worker',
            inputUncached: 1,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            budgetTokens: 1,
          }),
          prev,
          next,
        ),
      ).toEqual([]);
    },
  );
  it('does not walk out twice after exit/release', () => {
    const rm = model();
    rm.seats[0]!.attempts[0]!.endedAt = at;
    expect(
      effects(
        event('seat.released', { attemptId: 'worker', removeWorkspace: false }),
        rm,
        rm,
      ),
    ).toEqual([]);
    delete rm.seats[0]!.attempts[0]!.endedAt;
    rm.seats[0]!.attempts[0]!.released = true;
    expect(
      effects(
        event('seat.exited', {
          attemptId: 'worker',
          reason: 'done',
          expected: true,
        }),
        rm,
        rm,
      ),
    ).toEqual([]);
  });
  it('does not move a parcel already in review', () => {
    const rm = model();
    rm.workItems[0]!.status = 'in_review';
    expect(
      effects(
        event('workitem.status', { itemKey: 'A', status: 'in_review' }),
        rm,
        rm,
      ),
    ).toEqual([]);
  });
  // All persistent §3.3 rows belong to the VM, including tool color and statement bubbles.
  it.each([
    'seat.status',
    'seat.activity',
    'meeting.statement',
    'gate.opened',
    'stage.started',
    'workflow.completed',
    'unknown.future',
  ])('no transient effect for %s', (type) => {
    const rm = model();
    expect(effects({ ...spawn(), type } as DomainEvent, rm, rm)).toEqual([]);
  });
  it.each(['cancelled', 'superseded'])('does not celebrate %s', (reason) => {
    const rm = model();
    expect(
      effects(event('gate.closed', { gateId: 'final', reason }), rm, rm),
    ).toEqual([]);
  });
  it('does not print other artifacts', () => {
    const rm = model();
    expect(
      effects(
        event('artifact.created', {
          kind: 'statement',
          artifactId: 'a',
          submissionId: 's',
          attemptId: 'worker',
        }),
        rm,
        rm,
      ),
    ).toEqual([]);
  });
  it('handles absent models, foreign workflows and missing references', () => {
    const rm = model();
    expect(effects(spawn(), null, null)).toEqual([]);
    expect(effects({ ...spawn(), workflowId: 'other' }, rm, rm)).toEqual([]);
    for (const e of [
      event('message.nudge', {
        attemptId: 'missing',
        reason: 'missing-submission',
        subject: 'Nudge',
        body: 'Nudge',
      }),
      event('message.answered', {
        questionId: 'missing',
        by: 'user',
        body: 'Answer',
      }),
      event('message.answered', {
        questionId: 'q',
        by: 'agent',
        body: 'Answer',
      }),
      event('seat.exited', {
        attemptId: 'missing',
        reason: 'done',
        expected: true,
      }),
      event('usage.tokens', {
        attemptId: 'missing',
        inputUncached: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        budgetTokens: 1,
      }),
    ])
      expect(effects(e, rm, rm)).toEqual([]);
    expect(
      effects(
        event('workitem.status', { itemKey: 'A', status: 'in_progress' }),
        null,
        rm,
      ),
    ).toEqual([]);
  });
  it('uses the previous model when a reference disappeared, without mutation', () => {
    const prev = model(),
      next = model();
    next.seats = [];
    next.questions = [];
    const snapshot = structuredClone({ prev, next });
    expect(
      effects(
        event('message.answered', {
          questionId: 'q',
          by: 'agent',
          attemptId: 'lead',
          body: 'Answer',
        }),
        prev,
        next,
      ),
    ).toEqual([envelope(lead, inbox, seat)]);
    expect({ prev, next }).toEqual(snapshot);
  });
  it('does not move twice when queue selection precedes in_review', () => {
    const prev = model();
    const queue = event('ondemand.queue_changed', {
      stageId: 'implement',
      purpose: 'merge',
      current: 'A',
      queue: [],
    });
    const next = evolve(prev, { ...queue, seq: prev.lastSeq + 1 })!;
    expect(effects(queue, prev, next)).toEqual([
      parcel,
      envelope(inbox, counter),
    ]);
    const status = event('workitem.status', {
      itemKey: 'A',
      status: 'in_review',
    });
    expect(
      effects(status, next, evolve(next, { ...status, seq: next.lastSeq + 1 })),
    ).toEqual([]);
  });
  it('supports an initial model and missing queue/usage history', () => {
    const next = model();
    next.seats[0]!.usage.budgetTokens = 1;
    expect(
      effects(
        event('usage.tokens', {
          attemptId: 'worker',
          inputUncached: 1,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          budgetTokens: 1,
        }),
        null,
        next,
      ),
    ).toEqual([{ kind: 'paper-grow', at: seat, fromSheets: 0, toSheets: 1 }]);
    const prev = model();
    next.seats = [];
    expect(
      effects(
        event('usage.tokens', {
          attemptId: 'worker',
          inputUncached: 1,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          budgetTokens: 1,
        }),
        prev,
        next,
      ),
    ).toEqual([]);
    expect(
      effects(
        event('message.nudge', {
          attemptId: 'missing',
          reason: 'missing-submission',
          subject: 'Nudge',
          body: 'Nudge',
        }),
        null,
        next,
      ),
    ).toEqual([]);
    expect(
      effects(
        event('message.answered', {
          questionId: 'missing',
          by: 'user',
          body: 'Answer',
        }),
        null,
        next,
      ),
    ).toEqual([]);
    expect(
      effects(
        event('seat.released', { attemptId: 'worker', removeWorkspace: false }),
        null,
        model(),
      ),
    ).toEqual([
      {
        kind: 'walk-out',
        attemptId: 'worker',
        from: seat,
        to: { kind: 'entrance' },
      },
    ]);
    expect(
      effects(
        event('workitem.status', { itemKey: 'A', status: 'in_review' }),
        null,
        model(),
      ),
    ).toEqual([parcel]);
    expect(
      effects(
        event('ondemand.queue_changed', {
          stageId: 'implement',
          purpose: 'merge',
          current: 'A',
          queue: [],
        }),
        null,
        model(),
      ),
    ).toEqual([parcel, envelope(inbox, counter)]);
  });
});
