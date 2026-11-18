import { expect, it } from 'vitest';
import { createReact, DEFAULT_MODULES } from '../react.js';
import { startWorkflow } from '../test-support/fixtures.js';
import { runMeeting, scenario } from '../test-support/meeting.js';
import { pausingWorld, Simulator } from '../test-support/simulator.js';

it('keeps proposed work items private until approval and applies revisions', () => {
  const sim = runMeeting({ planning: true });
  const conclusion = sim.eventsOf('gate.opened').at(-1)!.payload;
  sim.dispatch({
    type: 'DecideGate',
    gateId: conclusion.gateId,
    decision: 'approve',
    by: 'user',
    expectedVersion: 1,
    requestedGithubBodyHash: 'a'.repeat(64),
    currentGithubBodyHash: 'a'.repeat(64),
    approvedSnapshot: {
      source: 'github',
      body: 'Approved',
      bodyHash: 'a'.repeat(64),
      structured: null,
    },
  });
  const gate = sim.eventsOf('gate.opened').at(-1)!.payload;
  expect(gate.stageId).toBe('breakdown');
  expect(
    sim.issued.filter((c) => c.command.kind === 'scm.createIssue'),
  ).toHaveLength(1);
  expect(sim.liveAgents()).toBe(0);
  sim.dispatch({
    type: 'DecideGate',
    gateId: gate.gateId,
    decision: 'revise',
    by: 'user',
    expectedVersion: 1,
    edits: {
      type: 'work-items',
      items: [
        {
          key: 'X',
          title: 'Revised',
          body: 'Updated',
          acceptance: ['Works'],
          role: 'engineer',
          agent: 'codex',
          deps: [],
        },
      ],
    },
  });
  expect(sim.state.workItemOrder).toEqual(['X']);
  expect(sim.state.workItems.X?.issue).toBe(1);
  expect(sim.rejections).toEqual([]);
  expect(
    sim
      .trace()
      .filter((line) =>
        /gate\.|workitem\.|scm.createIssue|stage.started/.test(line),
      ),
  ).toMatchSnapshot();
});

it('reruns planning with feedback and fresh single-turn attempt', () => {
  const sim = runMeeting({ planning: true });
  sim.dispatch({
    type: 'DecideGate',
    gateId: sim.eventsOf('gate.opened').at(-1)!.payload.gateId,
    decision: 'approve',
    by: 'user',
    expectedVersion: 1,
    requestedGithubBodyHash: 'a'.repeat(64),
    currentGithubBodyHash: 'a'.repeat(64),
    approvedSnapshot: {
      source: 'github',
      body: 'Approved',
      bodyHash: 'a'.repeat(64),
      structured: null,
    },
  });
  sim.dispatch({
    type: 'DecideGate',
    gateId: sim.eventsOf('gate.opened').at(-1)!.payload.gateId,
    decision: 'reject',
    by: 'user',
    expectedVersion: 1,
    comment: 'Split smaller',
  });
  expect(sim.state.stages.breakdown).toMatchObject({
    attempt: 2,
    feedback: 'Split smaller',
  });
  const planner = Object.values(sim.state.attempts).filter(
    (a) => a.purpose === 'planner',
  );
  expect(planner).toHaveLength(2);
  expect(planner.every((a) => !a.keepOpen && a.released)).toBe(true);
  expect(sim.rejections).toEqual([]);
  expect(
    sim
      .trace()
      .filter((line) =>
        /gate\.|workitem\.|scm.createIssue|stage.started/.test(line),
      ),
  ).toMatchSnapshot();
});

it('nudges a planner without output and raises the exception after grace', () => {
  const sim = runMeeting({ planning: true, missingItems: true }, true).advance(
    5 * 60_000,
  );
  expect(sim.eventsOf('gate.opened').at(-1)?.payload).toMatchObject({
    kind: 'exception',
    stageId: 'breakdown',
  });
  expect(sim.rejections).toEqual([]);
  expect(
    sim
      .trace()
      .filter((line) =>
        /gate\.|workitem\.|scm.createIssue|stage.started/.test(line),
      ),
  ).toMatchSnapshot();
});

it('times out a silent planner before its one grace period', () => {
  const sim = runMeeting({}, true).advance(30 * 60_000);
  expect(sim.eventsOf('message.nudge').at(-1)?.payload.attemptId).toContain(
    '/breakdown/',
  );
  sim.advance(5 * 60_000);
  expect(sim.eventsOf('gate.opened').at(-1)?.payload.kind).toBe('exception');
});

it('proposes work items submitted while paused once the workflow resumes', () => {
  const sim = new Simulator({
    world: pausingWorld(
      scenario({ planning: true }),
      (issued, current) =>
        issued.command.kind === 'runtime.spawnAgent' &&
        current.state.attempts[issued.attemptId!]?.purpose === 'planner',
    ),
    react: createReact({
      ...DEFAULT_MODULES,
      stages: { ...DEFAULT_MODULES.stages, implement: { react: () => [] } },
    }),
  });
  const start = startWorkflow();
  start.gateToggles = { conclusion: false };
  sim.dispatch(start);
  expect(sim.state.workflow?.pausedReasons).toEqual(['hijacked']);
  expect(sim.state.proposals.breakdown).toBeUndefined();
  sim.dispatch({ type: 'ResumeWorkflow', reason: 'hijacked' });
  expect(sim.state.proposals.breakdown?.items).toHaveLength(2);
  expect(sim.state.stages.breakdown?.status).toBe('awaiting_gate');
  expect(sim.eventsOf('gate.opened').at(-1)?.payload).toMatchObject({
    stageId: 'breakdown',
    kind: 'stage',
  });
  expect(sim.rejections).toEqual([]);
});
