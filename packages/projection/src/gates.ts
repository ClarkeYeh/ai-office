import type { GateView } from '@ai-office/contracts/api';
import type { DomainEvent } from '@ai-office/contracts/events';
import { findAttempt, lookup, type ReadModel } from './model.js';

function resolveContent(m: ReadModel, gate: GateView): void {
  const content = gate.content;
  if (content.type === 'exception') {
    if (content.questionId !== undefined) gate.questionId = content.questionId;
    return;
  }
  const accepted = lookup(m.acceptedSubmissions, content.artifactId);
  if (content.type === 'conclusion') {
    gate.conclusion = {
      original: accepted?.kind === 'conclusion' ? accepted.payload : null,
      renderedHash: content.renderedHash,
      changedOnGithub: false,
    };
  } else if (content.type === 'work-items') {
    gate.workItems =
      accepted?.kind === 'work-items' ? accepted.payload.items : [];
  } else {
    const artifact = m.artifacts.find(
      (a) => a.artifactId === content.artifactId,
    );
    const pr = m.prs.find((p) => p.number === (content.pr ?? artifact?.number));
    if (pr) gate.pr = { ...pr };
  }
}

export function applyGates(m: ReadModel, e: DomainEvent): void {
  switch (e.type) {
    case 'submission.accepted': {
      const p = e.payload;
      const found = findAttempt(m, p.attemptId);
      if (!found) return;
      // The engine keys stage artifacts by submissionId when none is given.
      const artifactId = p.artifactId ?? p.submissionId;
      m.acceptedSubmissions = {
        ...m.acceptedSubmissions,
        [artifactId]: {
          ...p.submission,
          submissionId: p.submissionId,
          seatId: found.seat.seatId,
          acceptedAtSeq: e.seq,
        },
      };
      return;
    }
    case 'gate.opened': {
      const p = e.payload;
      if (m.gates.some((g) => g.gateId === p.gateId)) return;
      const stage = m.stages.find((s) => s.stageId === p.stageId);
      const templateStage = m.template.stages.find((s) => s.id === p.stageId);
      const gate: GateView = {
        ...p,
        workflowId: m.workflowId,
        status: 'open',
        openedAt: e.occurredAt,
        ...(templateStage &&
        'gate' in templateStage &&
        templateStage.gate.editable
          ? { editable: templateStage.gate.editable }
          : {}),
      };
      resolveContent(m, gate);
      m.gates.push(gate);
      if (stage && p.kind === 'stage') {
        stage.status = 'awaiting_gate';
        stage.gateId = p.gateId;
      }
      if (gate.questionId) {
        const question = m.questions.find(
          (q) => q.questionId === gate.questionId,
        );
        if (question?.escalation) question.escalation.options = p.options;
      }
      return;
    }
    case 'gate.content_updated': {
      const p = e.payload;
      const gate = m.gates.find((g) => g.gateId === p.gateId);
      if (!gate || p.version < gate.version) return;
      gate.version = p.version;
      if (p.source === 'github') {
        if (gate.conclusion)
          Object.assign(gate.conclusion, {
            githubBodyHash: p.bodyHash,
            githubUpdatedAt: p.githubUpdatedAt,
            changedOnGithub: p.bodyHash !== gate.conclusion.renderedHash,
          });
      } else if (
        p.artifactId !== undefined &&
        gate.content.type !== 'exception'
      ) {
        gate.content = { ...gate.content, artifactId: p.artifactId };
        resolveContent(m, gate);
      }
      return;
    }
    case 'scm.issue_drift': {
      const p = e.payload;
      const gate = m.gates.find((g) => g.gateId === p.gateId);
      if (gate?.conclusion)
        Object.assign(gate.conclusion, {
          githubBodyHash: p.bodyHash,
          githubUpdatedAt: p.githubUpdatedAt,
          changedOnGithub: p.bodyHash !== gate.conclusion.renderedHash,
        });
      return;
    }
    case 'gate.decided': {
      const p = e.payload;
      const gate = m.gates.find((g) => g.gateId === p.gateId);
      if (!gate) return;
      gate.version = p.version;
      gate.status =
        p.decision === 'reject'
          ? 'rejected'
          : p.decision === 'revise'
            ? 'revised'
            : 'approved';
      gate.decision = {
        decision: p.decision,
        by: p.by,
        at: e.occurredAt,
        ...(p.optionId === undefined ? {} : { optionId: p.optionId }),
        ...(p.comment === undefined ? {} : { comment: p.comment }),
      };
      // Mirrors domain evolve: approve/revise settles the gated stage; reject
      // leaves it awaiting_gate until the rerun's stage.started.
      const stage = m.stages.find((s) => s.stageId === gate.stageId);
      if (
        gate.kind === 'stage' &&
        stage?.status === 'awaiting_gate' &&
        (p.decision === 'approve' || p.decision === 'revise')
      )
        stage.status = 'done';
      if (p.edits?.type === 'work-items') gate.workItems = p.edits.items;
      if (p.edits?.type === 'conclusion' && gate.conclusion)
        gate.conclusion.original = p.edits.conclusion;
      if (p.approvedSnapshot && gate.conclusion) {
        gate.conclusion.original = p.approvedSnapshot.structured;
        if (p.approvedSnapshot.source === 'github')
          Object.assign(gate.conclusion, {
            githubBodyHash: p.approvedSnapshot.bodyHash,
            changedOnGithub:
              p.approvedSnapshot.bodyHash !== gate.conclusion.renderedHash,
            ...(p.approvedSnapshot.githubUpdatedAt === undefined
              ? {}
              : { githubUpdatedAt: p.approvedSnapshot.githubUpdatedAt }),
          });
      }
      // CP2 retains the event's explicit gate-to-budget link across snapshots.
      if (p.additionalTokens !== undefined && gate.decision.by === 'user') {
        const bar = m.budgetBars.find(
          (b) => b.gateId === p.gateId && b.metric === 'tokens',
        );
        if (bar) {
          bar.budget += p.additionalTokens;
          bar.hardLimit = Math.ceil(bar.budget * m.budgets.hardLimitMultiplier);
          bar.level =
            bar.used >= bar.hardLimit
              ? 'hard_limit'
              : bar.used >= bar.budget
                ? 'exceeded'
                : 'ok';
        }
      }
      return;
    }
    case 'gate.closed': {
      const gate = m.gates.find((g) => g.gateId === e.payload.gateId);
      if (gate) {
        gate.status = 'closed';
        gate.closedAt = e.occurredAt;
        gate.closeReason = e.payload.reason;
        // Mirrors domain evolve: a merged close (final-pr) settles the stage.
        const stage = m.stages.find((s) => s.stageId === gate.stageId);
        if (e.payload.reason === 'merged' && stage?.status === 'awaiting_gate')
          stage.status = 'done';
      }
      return;
    }
  }
}
