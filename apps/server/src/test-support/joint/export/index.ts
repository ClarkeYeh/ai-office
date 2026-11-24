import { createHash } from 'node:crypto';
import { EVENT_TYPES, type EventType } from '@ai-office/contracts/events';
import { createRedactor } from '@ai-office/redaction';

export function textPlaceholder(text: string): string {
  return `‹text len=${text.length} sha=${createHash('sha256').update(text).digest('hex').slice(0, 12)}›`;
}

// Paths are exact (array indexes use *). Merely naming an unknown field "id"
// cannot promote its value into the allowlist. Free-text paths never appear here.
const envelope = [
  'id',
  'workflowId',
  'stageId',
  'seatId',
  'attemptId',
  'source',
  'provenance',
  'externalKey',
  'causationId',
];
const payloadPaths: Partial<Record<EventType, readonly string[]>> = {
  'workflow.started': [
    'requirement',
    'shortId',
    'integrationBranch',
    'repo.repoId',
    'repo.orcaRepoId',
    'repo.github.owner',
    'repo.github.name',
    'repo.visibility',
    'repo.ownerLogin',
    'repo.defaultBranchProtected',
    'templateSnapshot.apiVersion',
    'templateSnapshot.id',
    'templateSnapshot.roles.*.agent',
    'templateSnapshot.roles.*.effort',
    'roleOverrides.*.agent',
    'roleOverrides.*.effort',
    ...[
      'id',
      'kind',
      'facilitator',
      'participants.*',
      'owner',
      'from',
      'role',
      'onCall.role',
      'mergeQueue.role',
      'escalateOn.*',
      'gate.id',
      'gate.editable.*',
    ].map((path) => 'templateSnapshot.stages.*.' + path),
    'repo.id',
    'repo.defaultBranch',
    'limits.budgetEnforcement',
    'limits.workerBranchRetention',
  ],
  'workflow.paused': ['reason', 'gateId'],
  'workflow.resumed': ['reason'],
  'workflow.completed': ['mergeCommitSha'],
  'workflow.failed': ['reason', 'stageId'],
  'workflow.cancel_requested': ['by', 'gateId'],
  'stage.started': ['stageId', 'kind', 'mode', 'agentOverride'],
  'stage.completed': ['stageId'],
  'stage.failed': ['stageId', 'category'],
  'stage.rerun_requested': ['stageId', 'mode', 'by', 'gateId', 'agentOverride'],
  'gate.opened': [
    'gateId',
    'kind',
    'stageId',
    'stageKind',
    'templateGateId',
    'exceptionKind',
    'content.type',
    'content.artifactId',
    'content.renderedHash',
    'content.attemptId',
    'content.itemKey',
    'content.questionId',
    'content.commandId',
    'content.triggerEventId',
    'options.*.optionId',
    'options.*.input',
  ],
  'gate.content_updated': ['gateId', 'source', 'artifactId'],
  'gate.decided': ['gateId', 'decision', 'by', 'optionId', 'agent'],
  'gate.closed': ['gateId', 'reason'],
  'seat.spawned': [
    'attemptId',
    'seatId',
    'stageId',
    'role',
    'agent',
    'purpose',
    'itemKey',
    'retryOf',
    'model',
    'effort',
    'spawnCommandId',
    'ondemand.purpose',
  ],
  'seat.status': ['attemptId', 'state'],
  'seat.activity': ['attemptId'],
  'seat.degraded': ['attemptId', 'reason'],
  'seat.policy_violation': ['attemptId', 'hits.*.rule', 'hits.*.severity'],
  'seat.exited': ['attemptId'],
  'seat.released': ['attemptId'],
  'agent.unmanaged': ['dispatch', 'parentDispatch', 'agentKind'],
  'meeting.round_started': ['stageId', 'attemptIds.*'],
  'meeting.statement': ['stageId', 'attemptId', 'role', 'artifactId'],
  'meeting.round_completed': ['stageId', 'absentAttemptIds.*'],
  'meeting.concluded': ['stageId', 'conclusionArtifactId'],
  'submission.accepted': [
    'submissionId',
    'attemptId',
    'kind',
    'artifactId',
    'agentSession.provider',
    'agentSession.id',
    'submission.kind',
  ],
  'submission.rejected': ['reason', 'kind', 'attemptId'],
  'message.question': ['questionId', 'attemptId', 'itemKey'],
  'message.forwarded': ['questionId', 'to', 'toAttemptId'],
  'message.answered': ['questionId', 'by', 'attemptId', 'optionId', 'gateId'],
  'message.escalated': ['questionId', 'attemptId', 'gateId', 'reason'],
  'message.nudge': ['seatId', 'attemptId', 'subject'],
  'message.instruction': ['seatId', 'attemptId', 'subject'],
  'ondemand.started': ['stageId', 'purpose', 'attemptId'],
  'ondemand.queue_changed': ['stageId', 'purpose', 'queue.*', 'current'],
  'ondemand.stopped': ['stageId', 'purpose', 'attemptId', 'reason'],
  'workitem.proposed': [
    'artifactId',
    'stageId',
    'items.*.key',
    'items.*.agent',
    'items.*.dependsOn.*',
  ],
  'workitem.approved': [
    'artifactId',
    'stageId',
    'items.*.key',
    'items.*.agent',
    'items.*.dependsOn.*',
  ],
  'workitem.dispatched': [
    'stageId',
    'itemKey',
    'attemptId',
    'branch',
    'baseSha',
  ],
  'workitem.status': ['stageId', 'itemKey', 'status'],
  'workitem.merge_queued': ['stageId', 'itemKey', 'attemptId', 'headSha'],
  'workitem.rework_requested': ['stageId', 'itemKey', 'attemptId'],
  'workitem.merged': ['stageId', 'itemKey', 'mergeCommitSha'],
  'artifact.created': ['artifactId', 'kind', 'stageId', 'attemptId'],
  'pr.status': ['state', 'headSha', 'baseSha', 'mergeCommitSha'],
  'scm.issue_drift': ['artifactId', 'bodyHash'],
  'anomaly.detected': ['kind', 'severity', 'stageId', 'attemptId'],
  'usage.tokens': ['attemptId', 'stageId', 'itemKey', 'source'],
  'usage.turns': ['attemptId', 'stageId', 'itemKey'],
  'budget.exceeded': ['scope', 'stageId', 'itemKey', 'attemptId'],
  'budget.hard_limit': ['scope', 'stageId', 'itemKey', 'attemptId'],
  'command.issued': [
    'commandId',
    'orcaRequestId',
    'kind',
    'args.session',
    'args.agent',
    'args.workspace.kind',
    'args.workspace.workspace',
    'args.workspace.name',
    'args.workspace.branch',
    'args.workspace.baseBranch',
    'args.workspace.fetchBranch',
    'args.baseBranch',
    'args.fetchBranch',
    'args.branch',
    'args.name',
    'args.from',
    'args.base',
    'args.head',
    'args.method',
    'args.expectedHeadSha',
    'args.expectedBaseSha',
    'args.expectedBase',
    'args.specSha256',
  ],
  'command.succeeded': [
    'commandId',
    'kind',
    'result.agent',
    'result.session',
    'result.workspace',
    'result.baseSha',
    'result.headSha',
    'result.mergeCommitSha',
  ],
  'command.failed': ['commandId', 'kind', 'error.category', 'error.code'],
  'command.reconciled': ['commandId', 'kind', 'outcome'],
  'timer.scheduled': ['timerId', 'kind', 'stageId', 'attemptId'],
  'timer.fired': ['timerId', 'kind'],
  'timer.cancelled': ['timerId'],
  'repo.registered': ['repoId', 'defaultBranch'],
  'repo.updated': ['repoId', 'defaultBranch'],
  'health.changed': ['component', 'status'],
  'runtime.identity_restored': ['session'],
  'runtime.identity_hijacked': ['session'],
  'error.recorded': ['category', 'code', 'stageId', 'attemptId'],
};
export const EVENT_STRING_ALLOWLIST: Readonly<
  Record<EventType, readonly string[]>
> = Object.fromEntries(
  EVENT_TYPES.map((type) => [
    type,
    [
      ...envelope,
      ...(payloadPaths[type] ?? []).map((path) => 'payload.' + path),
    ],
  ]),
) as unknown as Record<EventType, readonly string[]>;

export interface JointExportOptions {
  exportedAt: string;
  aiOfficeCommit: string;
  orcaVersion: string;
  /** Exact authored requirements reviewed by the caller, never LLM output. */
  requirements?: readonly string[];
}

/** No disk writes: raw events and private export storage remain with the harness. */
export function exportJointEvents(
  events: readonly Record<string, unknown>[],
  options: JointExportOptions,
) {
  if (
    !/^[a-f0-9]{40}$/.test(options.aiOfficeCommit) ||
    !/^\d+\.\d+\.\d+$/.test(options.orcaVersion) ||
    !Number.isFinite(Date.parse(options.exportedAt))
  )
    throw new Error('Invalid export metadata');
  const redactor = createRedactor();
  const origin =
    events.map((e) => Date.parse(String(e.occurredAt))).find(Number.isFinite) ??
    0;
  const epoch = Date.parse('2000-01-01T00:00:00.000Z');
  const requirements = new Set(options.requirements ?? []);
  const safe = (value: string) =>
    redactor.maskText(value) === value &&
    !/aio_ctl_|\/(Users|home)\//.test(value);
  return {
    exportedAt: '2000-01-01T00:00:00.000Z',
    aiOfficeCommit: options.aiOfficeCommit,
    orcaVersion: options.orcaVersion,
    events: events.map((event) => {
      const type = typeof event.type === 'string' ? event.type : '';
      const allowed = new Set(EVENT_STRING_ALLOWLIST[type as EventType] ?? []);
      function visit(value: unknown, path: string): unknown {
        if (typeof value === 'string') {
          if (path === 'type' && EVENT_TYPES.includes(value as EventType))
            return value;
          if (
            ['occurredAt', 'recordedAt'].includes(path) &&
            Number.isFinite(Date.parse(value))
          )
            return new Date(epoch + Date.parse(value) - origin).toISOString();
          if (
            safe(value) &&
            allowed.has(path) &&
            (path === 'payload.requirement'
              ? requirements.has(value)
              : /^[A-Za-z0-9_./:#@+-]+$/.test(value))
          )
            return value;
          return textPlaceholder(value);
        }
        if (Array.isArray(value))
          return value.map((item) => visit(item, path + '.*'));
        if (value && typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
              key,
              visit(
                item,
                path
                  ? path +
                      '.' +
                      ([
                        'payload.templateSnapshot.roles',
                        'payload.roleOverrides',
                      ].includes(path)
                        ? '*'
                        : key)
                  : key,
              ),
            ]),
          );
        return value;
      }
      return visit(event, '');
    }),
  };
}
