import type { DomainEvent } from '@ai-office/contracts/events';
import { emptyUsage, findAttempt, type ReadModel } from './model.js';

export function applyWorkflow(m: ReadModel, e: DomainEvent): void {
  switch (e.type) {
    case 'workflow.paused':
      if (!m.pausedReasons.includes(e.payload.reason))
        m.pausedReasons.push(e.payload.reason);
      return;
    case 'workflow.resumed':
      m.pausedReasons = m.pausedReasons.filter((r) => r !== e.payload.reason);
      return;
    case 'workflow.completed':
      m.status = 'completed';
      m.endedAt = e.occurredAt;
      m.outcome = { ...e.payload };
      return;
    case 'workflow.failed':
      m.status = 'failed';
      m.endedAt = e.occurredAt;
      m.outcome = {
        failReason: e.payload.reason,
        ...(e.payload.detail === undefined ? {} : { detail: e.payload.detail }),
      };
      return;
    case 'workflow.cancel_requested':
      m.cancelRequested = true;
      return;
    case 'workflow.cancelled':
      m.status = 'cancelled';
      m.endedAt = e.occurredAt;
      return;
    case 'stage.started': {
      const p = e.payload;
      const stage = m.stages.find((s) => s.stageId === p.stageId);
      if (!stage || stage.runs.some((r) => r.attempt === p.attempt)) return;
      m.currentStageId = p.stageId;
      stage.status = 'running';
      delete stage.gateId;
      stage.runs.push({
        attempt: p.attempt,
        mode: p.mode,
        startedAt: e.occurredAt,
        ...(p.feedback === undefined ? {} : { feedback: p.feedback }),
        ...(p.agentOverride === undefined
          ? {}
          : { agentOverride: p.agentOverride }),
      });
      if (stage.meeting)
        stage.meeting = {
          round: 0,
          maxRounds: stage.meeting.maxRounds,
          concluded: false,
          statements: [],
        };
      return;
    }
    case 'stage.completed':
    case 'stage.failed': {
      const p = e.payload;
      const stage = m.stages.find((s) => s.stageId === p.stageId);
      const run = stage?.runs.find((r) => r.attempt === p.attempt);
      if (!stage || !run) return;
      run.endedAt = e.occurredAt;
      run.outcome = e.type === 'stage.completed' ? 'completed' : 'failed';
      if (e.type === 'stage.failed') run.failReason = e.payload.reason;
      if (stage.runs.at(-1) === run)
        stage.status = e.type === 'stage.completed' ? 'done' : 'failed';
      return;
    }
    // Requests are intent. The subsequent stage.started carries the new run's facts.
    case 'stage.rerun_requested':
      return;
    case 'meeting.round_started':
    case 'meeting.round_completed': {
      const stage = m.stages.find((s) => s.stageId === e.payload.stageId);
      if (stage?.meeting) stage.meeting.round = e.payload.round;
      return;
    }
    case 'meeting.statement': {
      const p = e.payload;
      const stage = m.stages.find((s) => s.stageId === p.stageId);
      if (stage?.meeting)
        stage.meeting.statements.push({
          round: p.statement.round,
          role: p.role,
          attemptId: p.attemptId,
          artifactId: p.artifactId,
          position: p.statement.position,
          readyToConclude: p.statement.readyToConclude,
          at: e.occurredAt,
        });
      return;
    }
    case 'meeting.concluded': {
      const stage = m.stages.find((s) => s.stageId === e.payload.stageId);
      if (stage?.meeting) {
        stage.meeting.concluded = true;
        stage.meeting.round = e.payload.rounds;
      }
      return;
    }
    case 'oncall.started': {
      const stage = m.stages.find((s) => s.stageId === e.payload.stageId);
      if (stage?.oncall) {
        stage.oncall.active = true;
        stage.oncall.attemptId = e.payload.attemptId;
      }
      return;
    }
    case 'oncall.queue_changed': {
      const stage = m.stages.find((s) => s.stageId === e.payload.stageId);
      if (stage?.oncall) {
        stage.oncall.queue = e.payload.queue;
        if (e.payload.current === undefined) delete stage.oncall.current;
        else stage.oncall.current = e.payload.current;
      }
      return;
    }
    case 'oncall.stopped': {
      const stage = m.stages.find((s) => s.stageId === e.payload.stageId);
      if (stage?.oncall && stage.oncall.attemptId === e.payload.attemptId) {
        stage.oncall.active = false;
        delete stage.oncall.current;
      }
      return;
    }
    case 'message.question': {
      const p = e.payload;
      const found = findAttempt(m, p.attemptId);
      if (!found || m.questions.some((q) => q.questionId === p.questionId))
        return;
      m.questions.push({
        ...p,
        workflowId: m.workflowId,
        seatId: found.seat.seatId,
        role: found.seat.role,
        status: 'open',
        askedAt: e.occurredAt,
      });
      return;
    }
    case 'message.forwarded': {
      const question = m.questions.find(
        (q) => q.questionId === e.payload.questionId,
      );
      if (question) {
        question.status = 'forwarded';
        question.forwardedTo = e.payload.to;
      }
      return;
    }
    case 'message.answered': {
      const p = e.payload;
      const question = m.questions.find((q) => q.questionId === p.questionId);
      if (question) {
        question.status = 'answered';
        question.answer = {
          by: p.by,
          body: p.body,
          at: e.occurredAt,
          ...(p.optionId === undefined ? {} : { optionId: p.optionId }),
        };
      }
      return;
    }
    case 'message.escalated': {
      const p = e.payload;
      const question = m.questions.find((q) => q.questionId === p.questionId);
      if (question) {
        question.status = 'escalated';
        question.escalation = {
          reason: p.reason,
          gateId: p.gateId,
          at: e.occurredAt,
          options: m.gates.find((g) => g.gateId === p.gateId)?.options ?? [],
        };
      }
      return;
    }
    case 'workitem.proposed':
    case 'workitem.approved':
      m.workItems = e.payload.items.map((item) => ({
        ...item,
        status: e.type === 'workitem.approved' ? 'approved' : 'proposed',
        attempts: 0,
        usage: emptyUsage(),
      }));
      return;
    case 'workitem.dispatched': {
      const p = e.payload;
      const item = m.workItems.find((w) => w.key === p.itemKey);
      if (item) {
        item.status = 'dispatched';
        item.attempts = p.attempt;
        item.currentAttemptId = p.attemptId;
        item.agent = p.agent;
        item.branch = p.branch;
        item.workspaceName = p.workspaceName;
        const found = findAttempt(m, p.attemptId);
        if (found) item.seatId = found.seat.seatId;
      }
      return;
    }
    case 'workitem.status': {
      const p = e.payload;
      const item = m.workItems.find((w) => w.key === p.itemKey);
      if (!item) return;
      item.status = p.status;
      if (p.attemptId !== undefined) item.currentAttemptId = p.attemptId;
      if (p.issue !== undefined) item.issue = { number: p.issue };
      if (p.pr !== undefined) {
        const pr = m.prs.find((pr) => pr.number === p.pr);
        if (pr) item.pr = { ...pr };
      }
      if (p.headSha !== undefined) item.headSha = p.headSha;
      if (p.reason !== undefined) item.reason = p.reason;
      return;
    }
    case 'anomaly.detected':
      m.anomalies.push({ ...e.payload, seq: e.seq, at: e.occurredAt });
      return;
    case 'error.recorded': {
      const error = {
        ...e.payload,
        seq: e.seq,
        at: e.occurredAt,
        ...(e.attemptId === undefined ? {} : { attemptId: e.attemptId }),
      };
      m.errors.push(error);
      if (e.attemptId !== undefined)
        findAttempt(m, e.attemptId)?.seat.errors.push(error);
      return;
    }
    case 'command.failed': {
      const error = {
        category: e.payload.error.category,
        code: e.payload.error.code,
        message: e.payload.error.message,
        commandId: e.payload.commandId,
        seq: e.seq,
        at: e.occurredAt,
        ...(e.attemptId === undefined ? {} : { attemptId: e.attemptId }),
      };
      m.errors.push(error);
      if (e.attemptId !== undefined)
        findAttempt(m, e.attemptId)?.seat.errors.push(error);
      return;
    }
  }
}
