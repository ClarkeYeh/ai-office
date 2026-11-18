import { describe, expect, it } from 'vitest';
import type { DomainCommand } from '../commands.js';
import {
  Harness,
  meta,
  startCommand,
  startStage,
  spawn,
  observe,
  eventDraft,
} from '../test-support/fixtures.js';
import { runTransitionRows } from '../test-support/transitions.js';

const opened = () =>
  new Harness().given(
    startCommand(),
    startStage('meeting'),
    spawn('p', 'pm'),
    spawn('a', 'architect'),
    spawn('lead', 'lead', 'meeting', { purpose: 'facilitator' }),
  );
const round: DomainCommand = {
  type: 'StartMeetingRound',
  meta: meta(),
  stageId: 'meeting',
  round: 1,
  attemptIds: ['p', 'a'],
};
const submit = (
  id: string,
  attemptId: string,
  kind: 'statement' | 'conclusion' = 'statement',
): DomainCommand => ({
  type: 'AcceptSubmission',
  meta: meta(),
  submissionId: id,
  attemptId,
  artifactId: `art-${id}`,
  submission:
    kind === 'statement'
      ? {
          kind,
          payload: {
            round: 1,
            position: 'Yes',
            arguments: [],
            concerns: [],
            readyToConclude: true,
          },
        }
      : {
          kind,
          payload: {
            summary: 'Agreed',
            decisions: [],
            techDecisions: [],
            openQuestions: [],
          },
        },
});
const record = (id: string): DomainCommand => ({
  type: 'RecordMeetingStatement',
  meta: meta(),
  stageId: 'meeting',
  submissionId: id,
});
const complete: DomainCommand = {
  type: 'CompleteMeetingRound',
  meta: meta(),
  stageId: 'meeting',
  round: 1,
  absentAttemptIds: [],
};
const ready = () =>
  opened().given(
    round,
    submit('s1', 'p'),
    record('s1'),
    observe('p', 'done'),
    submit('s2', 'a'),
    record('s2'),
    observe('a', 'done'),
  );
const conclude: DomainCommand = {
  type: 'ConcludeMeeting',
  meta: meta(),
  stageId: 'meeting',
  submissionId: 'c',
};
const artifact: DomainCommand = {
  type: 'RecordStageArtifact',
  meta: meta(),
  stageId: 'meeting',
  artifact: {
    kind: 'statement',
    artifactId: 'art-s1',
    submissionId: 's1',
    attemptId: 'p',
  },
};

runTransitionRows([
  {
    name: 'start first round',
    given: (h) => Object.assign(h, opened()),
    when: round,
    then: ['meeting.round_started'],
  },
  {
    name: 'record accepted statement',
    given: (h) => Object.assign(h, opened().given(round, submit('s1', 'p'))),
    when: record('s1'),
    then: ['meeting.statement'],
  },
  {
    name: 'complete finished round',
    given: (h) => Object.assign(h, ready()),
    when: complete,
    then: ['meeting.round_completed'],
  },
  {
    name: 'conclude after completed round',
    given: (h) =>
      Object.assign(
        h,
        ready().given(complete, submit('c', 'lead', 'conclusion')),
      ),
    when: conclude,
    then: ['meeting.concluded'],
  },
  {
    name: 'link accepted artifact',
    given: (h) => Object.assign(h, opened().given(round, submit('s1', 'p'))),
    when: artifact,
    then: ['artifact.created'],
  },
]);

describe('meeting validation boundaries', () => {
  const rejected = (h: Harness, command: DomainCommand, code: string) =>
    expect(h.run(command)).toMatchObject({ ok: false, error: { code } });
  it('requires a running unpaused meeting', () => {
    rejected(new Harness(), round, 'workflow_not_started');
    rejected(
      opened().given({
        type: 'PauseWorkflow',
        meta: meta(),
        reason: 'anomaly',
      }),
      round,
      'workflow_paused',
    );
    rejected(opened(), { ...round, stageId: 'breakdown' }, 'meeting_not_open');
    rejected(
      ready().given(complete, submit('c', 'lead', 'conclusion'), conclude),
      round,
      'meeting_not_open',
    );
  });
  it('requires sequential bounded rounds and valid distinct current participants', () => {
    rejected(opened(), { ...round, round: 2 }, 'invalid_round');
    rejected(opened().given(round), { ...round, round: 2 }, 'invalid_round');
    for (const ids of [[], ['p', 'p'], ['unknown'], ['lead']])
      rejected(opened(), { ...round, attemptIds: ids }, 'invalid_participants');
    rejected(
      opened().given({
        type: 'ReleaseAttempt',
        meta: meta(),
        attemptId: 'p',
        removeWorkspace: false,
      }),
      round,
      'invalid_participants',
    );
    rejected(ready().given(complete), { ...round, round: 3 }, 'invalid_round');
  });
  it('requires finished participants or valid explicit absence', () => {
    rejected(opened(), complete, 'round_not_open');
    rejected(ready().given(complete), complete, 'round_not_open');
    rejected(opened().given(round), complete, 'round_incomplete');
    rejected(
      ready(),
      { ...complete, absentAttemptIds: ['missing'] },
      'round_incomplete',
    );
    rejected(
      ready(),
      { ...complete, absentAttemptIds: ['p', 'p'] },
      'round_incomplete',
    );
    expect(
      opened()
        .given(round)
        .run({ ...complete, absentAttemptIds: ['p', 'a'] }),
    ).toMatchObject({ ok: true });
  });
  it('rejects stale or missing submissions and closed or foreign rounds', () => {
    rejected(opened(), record('missing'), 'invalid_submission');
    rejected(opened().given(submit('s1', 'p')), record('s1'), 'round_not_open');
    rejected(ready().given(complete), record('s1'), 'round_not_open');
    rejected(
      opened().given(round, submit('c', 'lead', 'conclusion')),
      record('c'),
      'round_not_open',
    );
    rejected(
      opened().given(round, submit('old', 'p'), submit('new', 'p')),
      record('old'),
      'invalid_submission',
    );
    rejected(
      opened().given(round, submit('c', 'lead', 'conclusion')),
      conclude,
      'meeting_incomplete',
    );
    rejected(
      ready(),
      { ...conclude, submissionId: 's1' },
      'meeting_incomplete',
    );
    rejected(
      opened().given(
        round,
        { ...complete, absentAttemptIds: ['p', 'a'] },
        submit('c', 'lead', 'conclusion'),
      ),
      conclude,
      'meeting_incomplete',
    );
  });
  it('links only validated submissions and successful issue results, idempotently', () => {
    rejected(new Harness(), artifact, 'unknown_stage');
    rejected(opened(), artifact, 'invalid_artifact');
    const h = opened().given(submit('s1', 'p'), artifact);
    expect(h.run(artifact)).toEqual({ ok: true, events: [] });
    const issue: DomainCommand = {
      type: 'RecordStageArtifact',
      meta: meta(),
      stageId: 'meeting',
      commandId: 'issue',
      artifact: {
        kind: 'issue',
        artifactId: 'issue',
        number: 1,
        url: 'https://github.com/o/r/issues/1',
        purpose: 'conclusion',
      },
    };
    rejected(h, issue, 'invalid_artifact');
    rejected(
      h,
      {
        ...issue,
        artifact: {
          kind: 'branch',
          artifactId: 'branch',
          name: 'branch',
          purpose: 'integration',
        },
      },
      'invalid_artifact',
    );
    h.given(
      eventDraft('command.issued', {
        commandId: 'issue',
        kind: 'scm.createIssue',
        args: {
          repo: { owner: 'o', name: 'r' },
          title: 'Conclusion',
          body: 'Body',
          labels: [],
        },
      }),
      eventDraft('command.succeeded', {
        commandId: 'issue',
        kind: 'scm.createIssue',
        result: { issue: 1, url: 'https://github.com/o/r/issues/1' },
      }),
    );
    expect(h.run(issue)).toMatchObject({ ok: true });
    rejected(
      h,
      {
        ...issue,
        artifact: {
          kind: 'issue',
          artifactId: 'other',
          number: 1,
          url: 'https://github.com/o/r/issues/1',
          purpose: 'work-item',
          itemKey: 'missing',
        },
      },
      'invalid_artifact',
    );
  });
});

it('records only the final PR proven by its successful openPR command', () => {
  const h = new Harness().given(startCommand());
  const workflow = h.state.workflow!;
  const pr = {
    type: 'RecordStageArtifact',
    meta: meta(),
    stageId: 'final-pr',
    commandId: 'final-open',
    artifact: {
      kind: 'pr',
      artifactId: 'final-pr-artifact',
      purpose: 'final',
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      head: workflow.integrationBranch,
      base: workflow.repo.defaultBranch,
    },
  } satisfies DomainCommand;
  expect(h.run(pr)).toMatchObject({ ok: false });
  h.given(
    eventDraft('command.issued', {
      commandId: 'final-open',
      kind: 'scm.openPR',
      args: {
        repo: workflow.repo.github,
        title: 'Final PR',
        body: 'Verified',
        head: workflow.integrationBranch,
        base: workflow.repo.defaultBranch,
      },
    }),
    eventDraft('command.succeeded', {
      commandId: 'final-open',
      kind: 'scm.openPR',
      result: { pr: 42, url: 'https://github.com/o/r/pull/42' },
    }),
  );
  for (const patch of [
    { purpose: 'worker' as const },
    { number: 43 },
    { base: 'wrong' },
    { head: 'wrong' },
    { url: 'https://github.com/o/r/pull/43' },
  ]) {
    expect(
      h.run({ ...pr, artifact: { ...pr.artifact, ...patch } }),
    ).toMatchObject({ ok: false });
  }
  h.given(pr);
  expect(h.state.workflow?.finalPr).toBe(42);
  expect(h.run(pr)).toEqual({ ok: true, events: [] });
});
