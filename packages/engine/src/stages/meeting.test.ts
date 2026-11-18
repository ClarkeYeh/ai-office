import { replay } from '@ai-office/domain';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Simulator } from '../test-support/simulator.js';
import { runMeeting, scenario } from '../test-support/meeting.js';
import { startWorkflow } from '../test-support/fixtures.js';
import { conclusionHash } from './meeting.js';

const checked = (sim: Simulator) => {
  expect(sim.rejections).toEqual([]);
  expect(sim.warnings).toEqual([]);
  expect(
    sim
      .trace()
      .filter((line) => /meeting\.|gate\.|stage\.|command.issued/.test(line)),
  ).toMatchSnapshot();
  for (const event of sim
    .eventsOf('gate.opened')
    .filter((e) => e.payload.kind === 'stage')) {
    const before = sim.events.filter((e) => e.seq < event.seq);
    const spawned = before.filter((e) => e.type === 'seat.spawned');
    for (const e of spawned)
      expect(
        before.some(
          (end) =>
            (end.type === 'seat.released' || end.type === 'seat.exited') &&
            end.payload.attemptId === e.payload.attemptId,
        ),
      ).toBe(true);
  }
};

describe('meeting stage protocol', () => {
  it('runs two rounds, stops/releases, disposes, publishes, then opens the gate', () => {
    const sim = runMeeting();
    checked(sim);
    expect(sim.eventsOf('meeting.round_completed')).toHaveLength(2);
    expect(sim.eventsOf('meeting.concluded')[0]?.payload.endedEarly).toBe(
      false,
    );
    expect(sim.state.stages.meeting?.status).toBe('awaiting_gate');
    expect(sim.liveAgents()).toBe(0);
    expect(
      sim.issued
        .filter((c) => c.command.kind === 'runtime.spawnAgent')
        .every(
          (c) =>
            c.command.kind === 'runtime.spawnAgent' && c.command.args.keepOpen,
        ),
    ).toBe(true);
    expect(sim.eventsOf('message.nudge')).toHaveLength(0);
  });
  it('bases the meeting worktree on the fetched remote default branch (§7.2)', () => {
    const sim = runMeeting();
    const repo = sim.state.workflow!.repo;
    expect(
      sim.issued.find((c) => c.command.kind === 'runtime.prepareWorkspace')
        ?.command,
    ).toMatchObject({
      args: {
        fetchBranch: repo.defaultBranch,
        baseBranch: `origin/${repo.defaultBranch}`,
      },
    });
  });
  it('concludes early when all effective speakers are ready', () => {
    const sim = runMeeting({ early: true });
    checked(sim);
    expect(sim.eventsOf('meeting.round_completed')).toHaveLength(1);
    expect(sim.eventsOf('meeting.concluded')[0]?.payload.endedEarly).toBe(true);
  });
  it('nudges done without statement once, then marks an absent participant', () => {
    const sim = runMeeting({ early: true, absent: ['pm'] });
    expect(sim.eventsOf('meeting.round_completed')).toHaveLength(0);
    sim.advance(5 * 60_000);
    checked(sim);
    expect(sim.eventsOf('meeting.round_completed')[0]?.payload).toMatchObject({
      statements: 2,
      absentAttemptIds: [expect.stringContaining('/pm')],
    });
    expect(sim.state.stages.meeting?.status).toBe('awaiting_gate');
  });
  it('opens an exception for fewer than two speakers', () => {
    const sim = runMeeting({ absent: ['pm', 'architect'] }).advance(5 * 60_000);
    checked(sim);
    expect(sim.eventsOf('gate.opened').at(-1)?.payload).toMatchObject({
      kind: 'exception',
      exceptionKind: 'stage-violation',
    });
  });
  it.each([{ missingConclusion: true }, { missingAgenda: true }])(
    'nudges missing required facilitator output then raises a violation (%j)',
    (options) => {
      const sim = runMeeting(options).advance(5 * 60_000);
      checked(sim);
      expect(sim.eventsOf('gate.opened').at(-1)?.payload.kind).toBe(
        'exception',
      );
    },
  );
  it('completes the meeting when a release fails permanently and the agent has exited', () => {
    const sim = runMeeting({ releaseFails: 'pm' });
    expect(sim.rejections).toEqual([]);
    expect(sim.eventsOf('command.failed').map((e) => e.payload.kind)).toEqual([
      'runtime.release',
    ]);
    expect(sim.state.stages.meeting?.status).toBe('awaiting_gate');
    expect(sim.eventsOf('gate.opened').at(-1)?.payload.kind).toBe('stage');
    expect(sim.liveAgents()).toBe(0);
  });
  it('opens the §8.1 anomaly gate when a release fails and the agent stays alive', () => {
    const sim = runMeeting({ releaseFails: 'pm', stuck: true });
    expect(sim.state.stages.meeting?.status).toBe('awaiting_gate');
    sim.advance(60_000).advance(30_000);
    expect(sim.rejections).toEqual([]);
    expect(sim.eventsOf('gate.opened').at(-1)?.payload).toMatchObject({
      kind: 'exception',
      exceptionKind: 'anomaly',
    });
    expect(sim.state.workflow?.pausedReasons).toContain('anomaly');
  });
  it('rejects a dirty worktree with filenames only', () => {
    const sim = runMeeting({ dirty: true });
    checked(sim);
    expect(sim.eventsOf('gate.opened').at(-1)?.payload.content).toMatchObject({
      type: 'exception',
      changedFiles: ['changed.ts'],
    });
    expect(sim.issued.some((c) => c.command.kind === 'scm.createIssue')).toBe(
      false,
    );
  });
  it('reruns with new attempts and supplied feedback after rejection', () => {
    const sim = runMeeting();
    const gate = sim.eventsOf('gate.opened').at(-1)!.payload;
    sim.dispatch({
      type: 'DecideGate',
      gateId: gate.gateId,
      expectedVersion: 1,
      decision: 'reject',
      by: 'user',
      comment: 'Consider alternatives',
    });
    checked(sim);
    expect(sim.state.stages.meeting?.attempt).toBe(2);
    expect(sim.state.stages.meeting?.feedback).toBe('Consider alternatives');
    expect(sim.eventsOf('meeting.concluded')).toHaveLength(2);
  });
  it('auto-approves optional gates and creates N issues only after work-item approval', () => {
    const sim = runMeeting({ planning: true }, true);
    checked(sim);
    expect(sim.eventsOf('gate.decided').map((e) => e.payload.by)).toEqual([
      'auto',
      'auto',
    ]);
    expect(sim.eventsOf('workitem.approved')[0]?.payload.items).toHaveLength(2);
    expect(
      sim.issued.filter((c) => c.command.kind === 'scm.createIssue'),
    ).toHaveLength(3);
    expect(
      sim
        .eventsOf('command.issued')
        .filter((e) => e.payload.kind === 'scm.createIssue')
        .slice(1)
        .every((e) => e.seq > sim.eventsOf('workitem.approved')[0]!.seq),
    ).toBe(true);
  });
  it.each(['', 'abc', '語言🦀', '\ud800', 'é', 'x'.repeat(200)])(
    'hashes the exact UTF-8 rendered body (%s)',
    (text) => {
      expect(conclusionHash(text)).toBe(
        createHash('sha256').update(text).digest('hex'),
      );
    },
  );
});

it('continues another round with surviving participants after an absence', () => {
  const sim = runMeeting({ absent: ['pm'] }).advance(5 * 60_000);
  // The existing round-completed contract durably records absence; do not invent
  // a statement from a participant who never submitted one.
  const rebuilt = replay(sim.events);
  const absent = Object.values(rebuilt.state.attempts).find(
    (a) => a.role === 'pm',
  )!;
  expect(rebuilt.warnings).toEqual([]);
  expect(
    rebuilt.state.meetings.meeting?.rounds[1]?.completed?.absentAttemptIds,
  ).toEqual([absent.attemptId]);
  expect(absent.released).toBe(true);
  expect(rebuilt.state.meetings.meeting?.rounds[2]?.attemptIds).not.toContain(
    absent.attemptId,
  );
  checked(sim);
  expect(sim.eventsOf('meeting.round_completed')).toHaveLength(2);
  expect(
    sim.eventsOf('meeting.round_started')[1]?.payload.attemptIds,
  ).toHaveLength(2);
  expect(sim.eventsOf('gate.opened').at(-1)?.payload.kind).toBe('stage');
});

it('waits for preparation worker_done before sending round 1', () => {
  const world = scenario({ early: true });
  const sim = new Simulator({
    world: (issued, current) => {
      const reply = world(issued, current);
      return issued.command.kind === 'runtime.spawnAgent' &&
        current.state.attempts[issued.attemptId ?? '']?.role === 'pm' &&
        reply
        ? { ...reply, observe: [] }
        : reply;
    },
  }).dispatch(startWorkflow());
  expect(sim.eventsOf('meeting.round_started')).toHaveLength(0);
  const participant = Object.values(sim.state.attempts).find(
    (a) => a.role === 'pm',
  )!;
  sim.dispatch({
    type: 'ObserveAttemptStatus',
    attemptId: participant.attemptId,
    state: 'done',
  });
  checked(sim);
  expect(sim.eventsOf('meeting.round_started')).toHaveLength(1);
});

it('waits for both statement and worker_done, then nudges on round timeout', () => {
  const world = scenario({ early: true });
  const sim = new Simulator({
    world: (issued, current) => {
      const reply = world(issued, current);
      if (
        issued.command.kind === 'runtime.send' &&
        issued.command.args.subject.startsWith('Meeting round') &&
        current.state.attempts[issued.attemptId ?? '']?.role === 'pm' &&
        reply
      )
        return {
          ...reply,
          observe:
            reply.observe?.filter((o) => o.type !== 'ObserveAttemptStatus') ??
            [],
        };
      return reply;
    },
  }).dispatch(startWorkflow());
  expect(sim.eventsOf('meeting.round_completed')).toHaveLength(0);
  sim.advance(15 * 60_000);
  expect(
    sim.issued.filter(
      (c) =>
        c.command.kind === 'runtime.send' &&
        c.command.args.subject === 'Required turn output',
    ),
  ).toHaveLength(1);
  sim.advance(5 * 60_000);
  checked(sim);
  expect(sim.eventsOf('meeting.round_completed')[0]?.payload.statements).toBe(
    2,
  );
});

it('does not let a satisfied agenda reminder expire the subsequent discussion', () => {
  const world = scenario({ missingAgenda: true });
  const sim = new Simulator({
    world: (issued, current) => {
      const reply = world(issued, current);
      return issued.command.kind === 'runtime.send' &&
        issued.command.args.subject.startsWith('Meeting round') &&
        reply
        ? { ...reply, observe: [] }
        : reply;
    },
  }).dispatch(startWorkflow());
  const lead = Object.values(sim.state.attempts).find(
    (a) => a.purpose === 'facilitator',
  )!;
  sim.dispatch({
    type: 'AcceptSubmission',
    attemptId: lead.attemptId,
    submissionId: 'late-agenda',
    submission: {
      kind: 'agenda',
      payload: { topics: [{ id: 'topic', title: 'Scope', focusByRole: {} }] },
    },
  });
  sim.advance(5 * 60_000);
  checked(sim);
  expect(sim.eventsOf('meeting.round_started')).toHaveLength(1);
  expect(sim.eventsOf('gate.opened')).toHaveLength(0);
});
