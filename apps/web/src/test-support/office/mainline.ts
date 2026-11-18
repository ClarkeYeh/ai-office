import { createLog, CONCLUSION_CONTENT, seatId } from './log.js';

// Hand-written mainline (SPEC §0.1 steps 1–9) with the visual states the office
// must show: a meeting, the conclusion and plan gates with everyone gone, three
// items where `dependent` waits for `feature`, a waiting_input question answered
// by on-call, a rework round trip in the merge queue, and the final PR merge.
// Marks name the golden checkpoints. Replace with the M4-T7 recording once it lands.

export function mainline() {
  const log = createLog({ maxParallel: 3 });
  const statement = (attemptId: string, role: string, round: number) =>
    log.push('meeting.statement', {
      stageId: 'meeting',
      attemptId,
      role,
      artifactId: `art-st-${attemptId}-${round}`,
      statement: {
        round,
        position: `${role} position`,
        arguments: [],
        concerns: [],
        readyToConclude: round === 2,
      },
    });

  // 1. meeting
  log.tick(5).stage('meeting', 'meeting');
  log.tick().spawn({
    attemptId: 'lead-1',
    role: 'lead',
    stageId: 'meeting',
    purpose: 'facilitator',
  });
  for (const [attemptId, role] of [
    ['pm-1', 'pm'],
    ['arch-1', 'architect'],
    ['eng-1', 'engineer'],
  ] as const) {
    log
      .tick()
      .spawn({ attemptId, role, stageId: 'meeting', purpose: 'participant' });
    log.status(attemptId, 'working');
  }
  log.status('lead-1', 'working');
  for (const round of [1, 2]) {
    log.tick(60).push('meeting.round_started', {
      stageId: 'meeting',
      round,
      attemptIds: ['pm-1', 'arch-1', 'eng-1'],
    });
    for (const [attemptId, role] of [
      ['pm-1', 'pm'],
      ['arch-1', 'architect'],
      ['eng-1', 'engineer'],
    ] as const) {
      log.tick(30);
      statement(attemptId, role, round);
    }
    if (round === 2) log.mark('meeting');
    log.push('meeting.round_completed', {
      stageId: 'meeting',
      round,
      statements: 3,
      absentAttemptIds: [],
      allReadyToConclude: round === 2,
    });
  }
  log.tokens('lead-1', 60_000).tokens('pm-1', 30_000);
  log.tick(30).push('meeting.concluded', {
    stageId: 'meeting',
    rounds: 2,
    endedEarly: false,
    conclusionArtifactId: 'art-conclusion',
  });
  for (const attemptId of ['pm-1', 'arch-1', 'eng-1', 'lead-1'])
    log.tick().exit(attemptId);
  log.push('artifact.created', {
    artifactId: 'art-issue-1',
    kind: 'issue',
    number: 1,
    url: 'https://github.com/octo/demo/issues/1',
    purpose: 'conclusion',
  });
  log
    .tick()
    .stageGate(
      'g-conclusion',
      'meeting',
      'meeting',
      '結論定案',
      CONCLUSION_CONTENT,
    );
  log.tick(192).mark('gate:conclusion');
  log.decide('g-conclusion').stageDone('meeting');

  // 2. planning
  log.tick(5).stage('planning', 'planning');
  log.tick().spawn({
    attemptId: 'lead-2',
    role: 'lead',
    stageId: 'planning',
    purpose: 'planner',
  });
  log.status('lead-2', 'working').mark('planning');
  log
    .tick(120)
    .items('workitem.proposed', [
      { key: 'feature' },
      { key: 'persist' },
      { key: 'dependent', deps: ['feature'] },
    ]);
  log.tick().exit('lead-2');
  log.tick().stageGate('g-plan', 'planning', 'planning', '任務拆分', {
    type: 'work-items',
    artifactId: 'art-plan',
  });
  log.tick(60).mark('gate:plan');
  log
    .decide('g-plan')
    .items('workitem.approved', [
      { key: 'feature' },
      { key: 'persist' },
      { key: 'dependent', deps: ['feature'] },
    ]);
  log.stageDone('planning');

  // 3. implement: feature and persist start, dependent waits on feature
  log.tick(5).stage('implement', 'implement');
  log.tick().dispatch('feature', 'f-1').status('f-1', 'working');
  log.tick().dispatch('persist', 'p-1').status('p-1', 'working');
  log.tick(30).activity('f-1', 'edit').activity('p-1', 'shell');
  log.tokens('f-1', 220_000).tokens('p-1', 148_000).mark('implement');

  // persist asks; on-call answers while persist waits
  log.tick(60).status('p-1', 'waiting_input');
  log.push('message.question', {
    questionId: 'q-1',
    attemptId: 'p-1',
    itemKey: 'persist',
    body: 'Which storage key?',
  });
  log.tick().spawn({
    attemptId: 'oncall-1',
    role: 'lead',
    stageId: 'implement',
    purpose: 'oncall',
    ondemand: 'oncall',
    attempt: 3,
  });
  log.push('ondemand.started', {
    stageId: 'implement',
    purpose: 'oncall',
    attemptId: 'oncall-1',
  });
  log.status('oncall-1', 'working');
  log.push('message.forwarded', {
    questionId: 'q-1',
    to: 'on-call',
    toAttemptId: 'oncall-1',
    retry: 0,
  });
  log.tick(45).mark('waiting');
  log.push('message.answered', {
    questionId: 'q-1',
    by: 'agent',
    body: 'theme',
    attemptId: 'oncall-1',
  });
  log.status('p-1', 'working');
  log.push('ondemand.stopped', {
    stageId: 'implement',
    purpose: 'oncall',
    attemptId: 'oncall-1',
    reason: 'queue_empty',
  });
  log.tick().exit('oncall-1');

  // feature: PR, merge queue, review, rework, second attempt, merge
  log.tick(120).openPr('feature', 'f-1', 5).exit('f-1');
  log.mergeQueued('feature', 'f-1', 5).queue(['feature']);
  log.tick().spawn({
    attemptId: 'int-1',
    role: 'integrator',
    stageId: 'implement',
    purpose: 'integrator',
    ondemand: 'merge',
  });
  log.push('ondemand.started', {
    stageId: 'implement',
    purpose: 'merge',
    attemptId: 'int-1',
  });
  log.status('int-1', 'working');
  log
    .queue([], 'feature')
    .itemStatus('feature', 'in_review', { attemptId: 'f-1' });
  log.tick(90).mark('review');
  log.push('workitem.rework_requested', {
    itemKey: 'feature',
    pr: 5,
    submissionId: 'sub-review-1',
    attemptId: 'int-1',
    reasons: ['missing tests'],
    rework: 1,
  });
  log.queue([]).mark('rework');
  log.tick(10).dispatch('feature', 'f-2', 2).status('f-2', 'working');
  log
    .tick(60)
    .itemStatus('feature', 'pr_open', { attemptId: 'f-2', pr: 5 })
    .exit('f-2');
  log.mergeQueued('feature', 'f-2', 5).queue([], 'feature');
  log.itemStatus('feature', 'in_review', { attemptId: 'f-2' });
  log.tick(30).merged('feature', 5).queue([]).mark('feature-merged');

  // persist and dependent finish
  log.tick(10).dispatch('dependent', 'd-1').status('d-1', 'working');
  log.tick(30).openPr('persist', 'p-1', 6).exit('p-1');
  log.mergeQueued('persist', 'p-1', 6).queue([], 'persist');
  log.itemStatus('persist', 'in_review', { attemptId: 'p-1' });
  log.tick(30).merged('persist', 6).queue([]);
  log.tick(60).openPr('dependent', 'd-1', 7).exit('d-1');
  log.mergeQueued('dependent', 'd-1', 7).queue([], 'dependent');
  log.itemStatus('dependent', 'in_review', { attemptId: 'd-1' });
  log.tick(30).merged('dependent', 7).queue([]);
  log.push('ondemand.stopped', {
    stageId: 'implement',
    purpose: 'merge',
    attemptId: 'int-1',
    reason: 'queue_empty',
  });
  log.exit('int-1').stageDone('implement');

  // 4. integrate, 5. final PR
  log.tick(5).stage('integrate', 'integrate').tick(60).stageDone('integrate');
  log.tick(5).stage('final-pr', 'final-pr');
  log.push('artifact.created', {
    artifactId: 'art-final',
    kind: 'pr',
    number: 9,
    url: 'https://github.com/octo/demo/pull/9',
    purpose: 'final',
    head: 'ai-office/ab12-dark-mode',
    base: 'main',
  });
  log.prStatus(9, 'final', 'open');
  log.stageGate('g-final', 'final-pr', 'final-pr', '最終 PR', {
    type: 'final-pr',
    artifactId: 'art-final',
    pr: 9,
  });
  log.tick(300).mark('gate:final');
  log.prStatus(9, 'final', 'merged');
  log.push('gate.closed', { gateId: 'g-final', reason: 'merged' });
  log.stageDone('final-pr');
  log.push('workflow.completed', {
    finalPr: 9,
    mergeCommitSha: 'c'.repeat(40),
  });
  log.mark('end');
  return log;
}

export const SEATS = {
  lead: seatId('lead'),
  pm: seatId('pm'),
  architect: seatId('architect'),
  engineer: seatId('engineer'),
  integrator: seatId('integrator'),
  feature: seatId('engineer', 'feature'),
  persist: seatId('engineer', 'persist'),
  dependent: seatId('engineer', 'dependent'),
} as const;
