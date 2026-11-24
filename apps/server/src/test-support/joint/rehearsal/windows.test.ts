import { describe, expect, it } from 'vitest';
import type { Json } from '../../orca/t17/checks.js';
import type { RestartRecord } from '../restart.js';
import {
  readyWithReconcileMs,
  segmentSemantics,
  windowAssertions,
  windowCommand,
  type WindowEvidence,
} from './windows.js';

const restart: RestartRecord = {
  trigger: 'K',
  triggerSeq: 3,
  oldPid: 10,
  newPid: 11,
  restartIssuedMs: 20,
  readyMs: 900,
  downtimeMs: 920,
  oldPidAliveAfter: false,
  runtimePidAfter: 11,
  withinBudget: true,
  readyAt: 1_000,
};
let seq = 0;
const ev = (type: string, payload: Json): Json => ({
  seq: ++seq,
  type,
  payload,
});

function p1Log(after: Json[]) {
  seq = 0;
  return [
    ev('workflow.started', { integrationBranch: 'ai-office/x/integration' }),
    ev('stage.started', { stageId: 'design', mode: 'meeting' }),
    ev('command.issued', { commandId: 'c1', kind: 'scm.createIssue' }),
    ...after,
  ];
}
const p1 = (objects: number, reconcileMs = 1_500): WindowEvidence => ({
  window: 'P1',
  hit: { window: 'P1', method: 'createIssue', commandId: 'c1' },
  killSeq: 3,
  restart,
  reconcileMs,
  objects,
});
const failed = (rows: { id: string; status: string }[]) =>
  rows.filter((r) => r.status === 'fail').map((r) => r.id);

describe('rehearsal window judgement', () => {
  it('passes a P1 reconciled as found with exactly one Issue', () => {
    const log = p1Log([
      ev('command.reconciled', {
        commandId: 'c1',
        kind: 'scm.createIssue',
        outcome: 'found',
      }),
      ev('command.succeeded', { commandId: 'c1', kind: 'scm.createIssue' }),
    ]);
    expect(failed(windowAssertions(log, p1(1)))).toEqual([]);
    expect(readyWithReconcileMs(p1(1))).toBe(1_500);
    expect(readyWithReconcileMs(p1(1, 100))).toBe(900);
  });

  it('fails a duplicate Issue, a re-issue, gave_up, a missing result and a slow ready', () => {
    const log = p1Log([
      ev('command.issued', { commandId: 'c1', kind: 'scm.createIssue' }),
      ev('command.reconciled', {
        commandId: 'c1',
        kind: 'scm.createIssue',
        outcome: 'gave_up',
      }),
      ev('command.failed', { commandId: 'c1', kind: 'scm.createIssue' }),
    ]);
    expect(failed(windowAssertions(log, p1(2, 61_000)))).toEqual([
      'P1.one-terminal',
      'P1.reconciled',
      'P1.not-reissued',
      'P1.one-issue',
      'P1.ready-60s',
    ]);
    const unfinished = windowAssertions(p1Log([]), {
      ...p1(1),
      reconcileMs: undefined,
    });
    expect(failed(unfinished)).toEqual([
      'P1.one-terminal',
      'P1.reconciled',
      'P1.ready-60s',
    ]);
  });

  it('fails when the command already had its result before the kill', () => {
    const log = p1Log([
      ev('command.succeeded', { commandId: 'c1', kind: 'scm.createIssue' }),
    ]);
    expect(failed(windowAssertions(log, { ...p1(1), killSeq: 4 }))).toContain(
      'P1.pending-at-kill',
    );
  });

  it('resolves the P2 command by PR and checks a single merge with the withheld commit', () => {
    seq = 0;
    const merge = 'm'.repeat(40);
    const log = [
      ev('command.issued', {
        commandId: 'old',
        kind: 'scm.mergePR',
        args: { pr: { number: 12 } },
      }),
      ev('command.succeeded', { commandId: 'old', kind: 'scm.mergePR' }),
      ev('command.issued', {
        commandId: 'c2',
        kind: 'scm.mergePR',
        args: { pr: { number: 12 } },
      }),
      ev('command.reconciled', {
        commandId: 'c2',
        kind: 'scm.mergePR',
        outcome: 'found',
      }),
      ev('command.succeeded', { commandId: 'c2', kind: 'scm.mergePR' }),
      ev('workitem.merged', { pr: 12, mergeCommitSha: merge }),
    ];
    const w: WindowEvidence = {
      window: 'P2',
      hit: { window: 'P2', method: 'mergePR', pr: 12, mergeCommitSha: merge },
      killSeq: 3,
      restart,
      reconcileMs: 2_000,
      objects: 1,
    };
    expect(windowCommand(log, w.hit, 3)).toBe('c2');
    expect(failed(windowAssertions(log, w))).toEqual([]);
    expect(
      failed(
        windowAssertions(
          [...log, ev('workitem.merged', { pr: 12, mergeCommitSha: merge })],
          { ...w, objects: 2 },
        ),
      ),
    ).toEqual(['P2.one-merge', 'P2.merged-once']);
  });

  it('keeps only flow and command kinds up to the kill in segment 1', () => {
    seq = 0;
    const log = [
      ev('workflow.started', { shortId: 'secret-free' }),
      ev('stage.started', { stageId: 'design', mode: 'meeting' }),
      ev('command.issued', { commandId: 'a', kind: 'scm.ensureBranch' }),
      ev('gate.opened', { stageId: 'design', kind: 'stage' }),
      ev('command.issued', { commandId: 'b', kind: 'runtime.spawnAgent' }),
      ev('stage.completed', { stageId: 'design' }),
    ];
    expect(segmentSemantics(log, 5)).toEqual({
      flow: [
        'workflow.started',
        'stage.started design meeting',
        'gate.opened design stage',
      ],
      commands: ['runtime.spawnAgent', 'scm.ensureBranch'],
    });
  });
});
