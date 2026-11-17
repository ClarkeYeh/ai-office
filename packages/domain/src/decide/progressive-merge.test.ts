import { describe, expect, test } from 'vitest';
import type { DomainCommand } from '../commands.js';
import { replay } from '../evolve.js';
import { initialState } from '../state/index.js';
import {
  Harness,
  eventDraft,
  meta,
  spawn,
  completeStage,
} from '../test-support/fixtures.js';
import {
  implementation,
  status,
  dispatch,
  dependency,
  choose,
  exit,
  queue,
  start,
  stop,
  timeout,
  instance,
  readyPR,
  reviewing,
  submission,
  rework,
  merged,
} from '../test-support/progressive-merge.js';

const reject = (h: Harness, command: DomainCommand, code: string) =>
  expect(h.run(command)).toMatchObject({ ok: false, error: { code } });

describe('progressive merge transitions and golden sequence', () => {
  test('golden: same-PR rework, merged dependency, shutdown and deterministic replay', () => {
    const h = reviewing().given(
      submission(),
      rework(),
      queue('merge', []),
      dispatch('A', 'worker-2'),
    );
    expect(h.state.workItems.A).toMatchObject({
      branch: 'ai-office/ab12/A',
      workspaceName: 'aio-ab12-A',
      pr: 11,
      rework: 1,
      attempt: 2,
      baseSha: 'abcdef1',
      reworkOf: 'review',
    });
    expect(h.events.at(-1)?.payload).toMatchObject({
      reworkOf: 'review',
      retryOf: 'worker',
    });
    h.given(
      status('A', 'in_progress'),
      status('A', 'pushed'),
      status('A', 'pr_open'),
      {
        type: 'QueueWorkItemForMerge',
        meta: meta(),
        item: {
          itemKey: 'A',
          attemptId: 'worker-2',
          pr: 11,
          headSha: 'abcdef4',
        },
      },
      queue('merge', ['A']),
      queue('merge', [], 'A'),
      submission('merge-request', 'merge-now'),
      merged,
      dispatch('B', 'dependent'),
      queue('merge', []),
      exit('merge'),
      stop('merge'),
    );
    expect(h.state.workItems.A?.mergeCommitSha).toBe('abcdef3');
    expect(h.state.workItems.B?.status).toBe('dispatched');
    expect(h.events.slice(-6).map((e) => e.type)).toEqual(
      [
        'submission.accepted',
        'workitem.merged',
        'workitem.dispatched',
        'ondemand.queue_changed',
        'seat.exited',
        'ondemand.stopped',
      ].slice(-8),
    );
    expect(replay(h.events, initialState()).state).toEqual(h.state);
  });
  test.each(['pr_open', 'merge_queued', 'in_review'] as const)(
    '%s does not satisfy readiness',
    (s) => {
      const h = implementation().given(
        eventDraft('workitem.status', { itemKey: 'A', status: s }),
      );
      reject(h, dispatch('B'), 'dependencies_not_ready');
    },
  );
  test('checks transitive dependencies even if a direct predecessor was merged', () => {
    const h = implementation().given(
      eventDraft('workitem.status', { itemKey: 'B', status: 'merged' }),
    );
    reject(h, dispatch('C'), 'dependencies_not_ready');
    h.given(
      eventDraft('workitem.status', { itemKey: 'A', status: 'merged' }),
      dispatch('C'),
    );
  });
});

describe('dependency exceptions and existing T9 gate options', () => {
  test.each(['failed', 'skipped'] as const)(
    '%s opens a deduplicated gate and requires explicit permission',
    (s) => {
      const h = implementation().given(status('A', s), dependency());
      expect(h.state.gates.dependency?.options.map((o) => o.optionId)).toEqual([
        'proceed',
        'skip',
        'abort',
      ]);
      expect(h.run(dependency())).toEqual({ ok: true, events: [] });
      reject(h, dispatch('B'), 'gate_open');
      h.given(choose('dependency', 'proceed'), dispatch('B'));
      // C has not itself been authorized to waive the transitive A dependency.
      h.given(
        eventDraft('workitem.status', { itemKey: 'B', status: 'merged' }),
      );
      reject(h, dispatch('C'), 'dependencies_not_ready');
      h.given(
        dependency('C', 'transitive'),
        choose('transitive', 'proceed'),
        dispatch('C', 'third'),
      );
    },
  );
  test('skip includes all downstream items, leaving unrelated work dispatchable', () => {
    const h = implementation().given(
      status('A', 'skipped'),
      dependency(),
      choose('dependency', 'skip'),
      dispatch('D'),
    );
    expect(h.state.workItems.B?.status).toBe('skipped');
    expect(h.state.workItems.C?.status).toBe('skipped');
    expect(h.state.workItems.D?.status).toBe('dispatched');
  });
  test('abort requests workflow cancellation', () => {
    const h = implementation().given(
      status('A', 'failed'),
      dependency(),
      choose('dependency', 'abort'),
    );
    expect(h.state.workflow?.cancelRequested).toBeTruthy();
  });
});

describe('rework limits and authorization', () => {
  test.each([0, 1, 2])(
    'override maxRework=%i; beyond the limit opens an exception',
    (limit) => {
      const h = reviewing();
      const config = h.state.workflow!.template.stages.find(
        (s) => s.kind === 'implement',
      )!;
      if (config.kind === 'implement') config.mergeQueue.maxRework = limit;
      h.state.workItems.A!.rework = limit;
      h.given(submission(), rework());
      expect(h.state.workItems.A).toMatchObject({
        rework: limit + 1,
        status: 'needs_attention',
      });
      expect(
        h.state.gates['rework-limit']?.options.map((o) => o.optionId),
      ).toEqual(['rework', 'retry', 'reassign', 'skip', 'abort']);
      reject(h, dispatch('A', 'next'), 'gate_open');
      h.given(choose('rework-limit', 'rework'), dispatch('A', 'next'));
      expect(h.state.workItems.A?.branch).toBe('ai-office/ab12/A');
    },
  );
  test('defaults.maxReruns is the fallback; retry uses a fresh branch and removes old PR metadata', () => {
    const h = reviewing();
    const config = h.state.workflow!.template.stages.find(
      (s) => s.kind === 'implement',
    )!;
    if (config.kind === 'implement') delete config.mergeQueue.maxRework;
    h.state.workflow!.template.defaults.maxReruns = 0;
    h.given(
      submission(),
      rework(),
      choose('rework-limit', 'retry'),
      dispatch('A', 'next'),
    );
    expect(h.state.workItems.A?.branch).toBe('ai-office/ab12/A-a2');
    expect(h.state.workItems.A?.pr).toBeUndefined();
  });
  test.each(['merge-request', 'rework-request'] as const)(
    '%s is confined to the current merge instance and PR',
    (kind) => {
      const h = reviewing().given(
        spawn('oncall', 'lead', 'implement', { purpose: 'oncall' }),
      );
      reject(h, submission(kind, 'wrong-role', 'oncall'), 'not_allowed');
      reject(h, submission(kind, 'wrong-pr', 'merge', 12), 'not_allowed');
      h.given(submission(kind));
    },
  );
  test('requires an accepted rework request and rejects applying it again on a later review', () => {
    const h = reviewing();
    reject(h, rework(), 'not_allowed');
    h.given(submission(), rework());
    reject(h, rework(), 'not_allowed');
    h.given(
      eventDraft('workitem.status', { itemKey: 'A', status: 'in_review' }),
    );
    reject(h, rework(), 'duplicate_rework');
  });
});

describe.each(['oncall', 'merge'] as const)(
  'shared on-demand rules: %s',
  (purpose) => {
    const key = purpose === 'merge' ? 'A' : 'q';
    const setup = () => {
      const h =
        purpose === 'merge'
          ? readyPR()
          : implementation().given(
              dispatch(),
              spawn('worker', 'engineer', 'implement', {
                purpose: 'worker',
                itemKey: 'A',
              }),
              {
                type: 'AskQuestion',
                meta: meta(),
                questionId: 'q',
                attemptId: 'worker',
                body: 'Help',
              },
            );
      return instance(h.given(queue(purpose, [key])), purpose).given(
        queue(purpose, [], key),
      );
    };
    test('one live instance, one current entry and stop before stage completion', () => {
      const h = setup();
      reject(
        h,
        spawn(
          'duplicate',
          purpose === 'merge' ? 'integrator' : 'lead',
          'implement',
          { purpose: purpose === 'merge' ? 'integrator' : 'oncall' },
        ),
        'ondemand_alive',
      );
      reject(h, queue(purpose, []), 'current_unresolved');
      reject(h, completeStage('implement'), 'ondemand_alive');
      reject(h, stop(purpose), 'attempt_alive');
      h.given(exit(purpose, true));
      reject(h, completeStage('implement'), 'ondemand_alive');
      h.given(
        exit(purpose),
        stop(purpose, purpose, 'stage_ended'),
        completeStage('implement'),
      );
    });
    test('first timeout nudges once; stale timers cannot change the next entry', () => {
      const h = setup();
      expect(h.run(timeout(purpose))).toMatchObject({
        ok: true,
        events: [{ type: 'message.nudge' }],
      });
      h.given(timeout(purpose));
      expect(h.state.attempts[purpose]?.nudges).toHaveLength(1);
      reject(h, timeout(purpose), 'stale_ondemand');
      if (purpose === 'oncall')
        expect(h.state.questions.q?.status).toBe('escalated');
      else expect(h.state.ondemand.implement?.merge?.queue).toEqual(['A']);
    });
    test.each([false, true])(
      'failed instance gets one replacement, then escalation (lost=%s)',
      (lost) => {
        const h = setup().given(
          exit(purpose, lost),
          timeout(purpose),
          stop(purpose, purpose, 'failed'),
        );
        instance(h, purpose, 'replacement').given(
          queue(purpose, [], key),
          exit('replacement', lost),
          timeout(purpose, 'replacement'),
        );
        expect(h.state.gates.timeout?.kind).toBe('exception');
        if (purpose === 'merge')
          expect(h.state.workItems.A?.status).toBe('needs_attention');
        else expect(h.state.questions.q?.status).toBe('escalated');
        expect(replay(h.events, initialState()).state).toEqual(h.state);
      },
    );
    test('empty queues require a stopped instance before recording idle shutdown', () => {
      const h = setup();
      if (purpose === 'merge') h.given(merged);
      else
        h.given(
          eventDraft('message.answered', {
            questionId: 'q',
            by: 'user',
            body: 'Answer',
          }),
        );
      h.given(queue(purpose, []), exit(purpose), stop(purpose));
      expect(h.run(stop(purpose))).toEqual({ ok: true, events: [] });
      expect(h.state.ondemand.implement?.[purpose]?.stopped).toBe(
        'queue_empty',
      );
    });
  },
);

describe('on-demand rejection boundaries', () => {
  test('requires a running workflow and implementation stage', () => {
    reject(new Harness(), start('merge'), 'workflow_not_started');
    const h = implementation();
    reject(
      h,
      {
        type: 'StartOnDemand',
        meta: meta(),
        instance: { stageId: 'missing', purpose: 'merge', attemptId: 'x' },
      },
      'unknown_stage',
    );
    reject(
      h,
      {
        type: 'StartOnDemand',
        meta: meta(),
        instance: { stageId: 'meeting', purpose: 'merge', attemptId: 'x' },
      },
      'stage_not_running',
    );
    reject(h, start('merge'), 'not_allowed');
    reject(h, stop('merge'), 'stale_ondemand');
    h.given(
      spawn('merge', 'integrator', 'implement', { purpose: 'integrator' }),
    );
    reject(h, start('merge'), 'queue_empty');
    reject(
      h,
      spawn('wrong-role', 'engineer', 'implement', { purpose: 'oncall' }),
      'not_allowed',
    );
    reject(
      h,
      spawn('not-kept', 'lead', 'implement', {
        purpose: 'oncall',
        keepOpen: false,
      }),
      'not_allowed',
    );
  });
  test('queue IDs, pending input, FIFO and live instance validation', () => {
    const h = readyPR();
    reject(h, queue('merge', ['A', 'A']), 'invalid_queue');
    reject(h, queue('merge', ['A'], 'A'), 'invalid_queue');
    reject(h, queue('merge', ['missing']), 'invalid_queue_entry');
    reject(h, queue('oncall', ['missing']), 'invalid_queue_entry');
    reject(h, queue('merge', [], 'A'), 'ondemand_not_running');
    instance(h.given(queue('merge', ['A'])), 'merge');
    expect(h.run(start('merge'))).toEqual({ ok: true, events: [] });
    h.given(
      eventDraft('ondemand.queue_changed', {
        stageId: 'implement',
        purpose: 'merge',
        queue: [],
      }),
    );
    reject(h, queue('merge', [], 'A'), 'queue_order');
    h.given(queue('merge', ['A']), queue('merge', [], 'A'), exit('merge'));
    reject(h, stop('merge'), 'queue_not_empty');
    // Failed current work may be explicitly requeued, but never silently dropped.
    h.given(queue('merge', ['A']));
    reject(h, queue('merge', [], 'A'), 'ondemand_not_running');
  });
  test('a second instance cannot register even with a distinct seat', () => {
    const h = reviewing();
    const old = h.state.attempts.merge!;
    h.given(
      eventDraft('seat.spawned', {
        ...old,
        attemptId: 'duplicate',
        seatId: 'wf-1:other',
        role: 'other',
      }),
    );
    reject(h, start('merge', 'duplicate'), 'ondemand_alive');
  });
  test('timeout replacement cannot be the same attempt, nor exceed one replacement', () => {
    const h = reviewing().given(timeout('merge'), timeout('merge'));
    reject(h, queue('merge', [], 'A'), 'replacement_required');
    h.given(exit('merge'));
    instance(h, 'merge', 'second').given(
      queue('merge', [], 'A'),
      exit('second'),
      queue('merge', ['A']),
    );
    instance(h, 'merge', 'third');
    reject(h, queue('merge', [], 'A'), 'ondemand_retry_limit');
  });
  test('current can be repeated, but unresolved work cannot be exchanged for another entry', () => {
    const h = reviewing().given(queue('merge', [], 'A'));
    h.given(
      eventDraft('workitem.status', {
        itemKey: 'D',
        status: 'merge_queued',
        pr: 12,
      }),
    );
    reject(h, queue('merge', [], 'D'), 'current_unresolved');
    h.given(exit('merge'));
    instance(h, 'merge', 'second');
    reject(h, queue('merge', ['A'], 'D'), 'current_unresolved');
  });
});

describe('work-item and exception rejection boundaries', () => {
  const enqueue: DomainCommand = {
    type: 'QueueWorkItemForMerge',
    meta: meta(),
    item: { itemKey: 'A', attemptId: 'worker', pr: 11, headSha: 'abcdef2' },
  };
  test('queue and transition commands reject stale or incomplete lifecycle metadata', () => {
    const h = implementation();
    reject(h, enqueue, 'stale_attempt');
    h.given(dispatch());
    reject(h, enqueue, 'invalid_item_transition');
    h.given(
      status('A', 'in_progress'),
      status('A', 'pushed'),
      status('A', 'pr_open'),
    );
    reject(h, status('A', 'merge_queued'), 'dedicated_command_required');
    h.given(
      eventDraft('workitem.status', {
        itemKey: 'A',
        status: 'pr_open',
        pr: 12,
      }),
    );
    reject(h, enqueue, 'wrong_pr');
    reject(h, merged, 'invalid_item_transition');
    h.given(
      eventDraft('workitem.status', { itemKey: 'A', status: 'merge_queued' }),
    );
    reject(h, status('A', 'in_review'), 'not_current_review');
    h.given(
      eventDraft('workitem.status', { itemKey: 'A', status: 'proposed' }),
    );
    reject(h, status('A', 'approved'), 'approval_required');
    h.given(eventDraft('workitem.status', { itemKey: 'A', status: 'rework' }));
    delete h.state.workItems.A!.branch;
    reject(h, dispatch('A', 'again'), 'missing_rework_workspace');
  });
  test('dependency checks are no-ops without failures and handle missing and cyclic edges safely', () => {
    const h = implementation();
    expect(h.run(dependency())).toEqual({ ok: true, events: [] });
    h.state.workItems.A!.deps = ['B', 'missing'];
    reject(h, dispatch(), 'dependencies_not_ready');
    h.given(
      status('A', 'failed'),
      dependency(),
      choose('dependency', 'proceed'),
    );
    expect(h.run(dependency())).toEqual({ ok: true, events: [] });
    reject(h, dispatch('B'), 'dependencies_not_ready');
    h.given(eventDraft('workitem.status', { itemKey: 'B', status: 'merged' }));
    expect(h.run(dependency())).toEqual({ ok: true, events: [] });
  });
  test('dependency gate creation checks stage and gate identity', () => {
    const h = implementation().given(status('A', 'failed'));
    reject(h, dependency('B', 'conclusion'), 'duplicate_gate');
    h.state.stages.implement!.status = 'done';
    reject(h, dependency(), 'stage_not_running');
  });
  test('rework gate ID collisions do not partially apply the request', () => {
    const h = reviewing().given(submission());
    h.state.workItems.A!.rework = 2;
    reject(
      h,
      {
        type: 'RequestWorkItemRework',
        meta: meta(),
        submissionId: 'review',
        gateId: 'conclusion',
      },
      'duplicate_gate',
    );
    expect(h.state.workItems.A!.status).toBe('in_review');
  });
  test('review gate options support requeue, explicit human merge, and skip', () => {
    for (const option of ['requeue', 'merge', 'skip']) {
      const h = reviewing();
      const delivery = h.state.ondemand.implement!.merge!.deliveries!.A!;
      delivery.retries = 1;
      h.given(timeout('merge'), timeout('merge'), choose('timeout', option));
      if (option === 'requeue') {
        expect(h.state.workItems.A?.status).toBe('merge_queued');
        h.given(
          queue('merge', ['A']),
          queue('merge', [], 'A'),
          timeout('merge'),
        );
        expect(h.state.attempts.merge?.nudges).toHaveLength(1);
      }
      if (option === 'merge') h.given(merged);
      if (option === 'skip')
        expect(h.state.workItems.A?.status).toBe('skipped');
    }
  });
  test('new exception options are accepted by OpenGate, while old T9 options remain covered', () => {
    const h = implementation();
    h.given(
      {
        type: 'OpenGate',
        meta: meta(),
        noLiveAttempts: false,
        gate: {
          gateId: 'blocked',
          stageId: 'implement',
          kind: 'exception',
          exceptionKind: 'merge-blocked',
          title: 'Conflict',
          options: [
            { optionId: 'retry', label: 'Retry' },
            { optionId: 'abort', label: 'Abort' },
          ],
          content: { type: 'exception', itemKey: 'A', summary: 'Conflict' },
        },
      },
      choose('blocked', 'retry'),
    );
    expect(h.state.workItems.A?.status).toBe('needs_attention');
  });
});

test('integrate accepts only a remaining worker PR; rework remains implement-only', () => {
  const h = readyPR().given(
    completeStage('implement'),
    { type: 'StartStage', stageId: 'integrate', meta: meta() },
    spawn('finisher', 'integrator', 'integrate', {
      purpose: 'integrator',
      keepOpen: false,
    }),
  );
  reject(
    h,
    submission('merge-request', 'unknown', 'finisher', 12),
    'not_allowed',
  );
  reject(
    h,
    submission('rework-request', 'wrong-stage', 'finisher'),
    'not_allowed',
  );
  h.given(submission('merge-request', 'finish', 'finisher'), merged);
  expect(h.events.at(-1)?.stageId).toBe('integrate');
  reject(
    h,
    submission('merge-request', 'already-merged', 'finisher'),
    'not_allowed',
  );
});

test('a failed rework attempt retries on a new branch without carrying reworkOf or the old PR', () => {
  const h = reviewing().given(
    submission(),
    rework(),
    dispatch('A', 'worker-2'),
  );
  expect(h.state.workItems.A).toMatchObject({
    reworkOf: 'review',
    pr: 11,
    branch: 'ai-office/ab12/A',
    baseSha: 'abcdef1',
  });
  h.given(status('A', 'failed'), dispatch('A', 'worker-3'));
  expect(h.state.workItems.A).toMatchObject({
    branch: 'ai-office/ab12/A-a3',
    attempt: 3,
    baseSha: 'abcdef1',
  });
  expect(h.state.workItems.A?.reworkOf).toBeUndefined();
  expect(h.state.workItems.A?.pr).toBeUndefined();
  expect(h.events.at(-1)?.payload).toMatchObject({ retryOf: 'worker-2' });
  expect(h.events.at(-1)?.payload).not.toHaveProperty('reworkOf');
  expect(replay(h.events, initialState()).state).toEqual(h.state);
});
