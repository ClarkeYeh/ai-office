import { createHash } from 'node:crypto';
import { EVENT_TYPES, type EventType } from '@ai-office/contracts/events';
import { createRedactor } from '@ai-office/redaction';

export function textPlaceholder(text: string): string {
  return `‹text len=${text.length} sha=${createHash('sha256').update(text).digest('hex').slice(0, 12)}›`;
}

/**
 * Opaque local ids the public fixture must not carry (coordinator ruling for
 * M5-T17): Orca run, dispatch and message ids and every UUID (Orca request,
 * repo and workspace ids, vendor agent sessions, vendor message ids), also
 * inside composite strings such as `orca:tx:ctx_…:<uuid>:seat.activity`.
 */
export const OPAQUE_ID =
  /(?<![A-Za-z0-9])(?:(run|ctx|msg)_([A-Za-z0-9]+)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![A-Za-z0-9])/gi;

/** The pseudonyms `pseudonymizer` hands out; never a real id. */
export const PSEUDONYM =
  /^(?:(?:run|ctx|msg)_0*[1-9][0-9]*|00000000-0000-4000-8000-[0-9]{12})$/;

/**
 * Deterministic within one export: the n-th distinct id of a kind becomes the
 * n-th pseudonym, so equal ids stay equal and links survive. Lengths are kept
 * (placeholders report `len=`), and a UUID stays UUID-shaped.
 */
export function pseudonymizer(): (text: string) => string {
  const seen = new Map<string, string>();
  const counts = new Map<string, number>();
  const next = (kind: string) => {
    const n = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, n);
    return n;
  };
  return (text) =>
    text.replace(OPAQUE_ID, (id, prefix?: string, rest?: string) => {
      const key = prefix ? id : id.toLowerCase();
      let alias = seen.get(key);
      if (alias === undefined) {
        const kind = prefix?.toLowerCase() ?? 'uuid';
        const n = String(next(kind));
        alias = prefix
          ? `${prefix}_${n.padStart(rest!.length, '0')}`
          : `00000000-0000-4000-8000-${n.padStart(12, '0')}`;
        seen.set(key, alias);
      }
      return alias;
    });
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
  'stage.failed': ['stageId', 'reason'],
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
  'message.escalated': ['questionId', 'gateId', 'reason'],
  'message.nudge': ['attemptId', 'reason', 'subject'],
  'message.instruction': ['seatId', 'attemptId', 'subject'],
  'ondemand.started': ['stageId', 'purpose', 'attemptId'],
  'ondemand.queue_changed': ['stageId', 'purpose', 'queue.*', 'current'],
  'ondemand.stopped': ['stageId', 'purpose', 'attemptId', 'reason'],
  'workitem.proposed': [
    'stageId',
    'submissionId',
    'items.*.key',
    'items.*.agent',
    'items.*.deps.*',
  ],
  'workitem.approved': [
    'gateId',
    'items.*.key',
    'items.*.agent',
    'items.*.deps.*',
  ],
  'workitem.dispatched': [
    'itemKey',
    'attemptId',
    'agent',
    'branch',
    'workspaceName',
    'baseSha',
    'retryOf',
    'reworkOf',
  ],
  'workitem.status': ['itemKey', 'status', 'attemptId', 'headSha'],
  'workitem.merge_queued': ['itemKey', 'attemptId', 'headSha'],
  'workitem.rework_requested': ['itemKey', 'attemptId', 'submissionId'],
  'workitem.merged': ['itemKey', 'mergeCommitSha', 'commandId'],
  'artifact.created': [
    'artifactId',
    'kind',
    'submissionId',
    'attemptId',
    'purpose',
    'itemKey',
    'name',
    'head',
    'base',
  ],
  'pr.status': [
    'state',
    'base',
    'head',
    'headSha',
    'checks',
    'mergedBy',
    'mergeCommitSha',
  ],
  'scm.issue_drift': ['bodyHash', 'itemKey', 'gateId'],
  'anomaly.detected': [
    'kind',
    'severity',
    'attemptId',
    'author',
    'sha',
    'dispatch',
    'commandId',
    'commentId',
  ],
  'usage.tokens': ['attemptId'],
  'usage.turns': ['attemptId'],
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
  'timer.scheduled': [
    'timerId',
    ...[
      'purpose',
      'stageId',
      'itemKey',
      'attemptId',
      'questionId',
      'ondemand',
      'reason',
      'phase',
    ].map((path) => 'payload.' + path),
  ],
  'timer.fired': ['timerId'],
  'timer.cancelled': ['timerId'],
  'repo.registered': ['repoId', 'defaultBranch'],
  'repo.updated': ['repoId', 'defaultBranch'],
  'health.changed': ['component', 'status'],
  'runtime.identity_restored': ['newShim', 'runs.*'],
  'runtime.identity_hijacked': ['run', 'coordinatorHandle'],
  'error.recorded': ['category', 'code', 'commandId'],
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
  // Before the allowlist, so placeholders hash the pseudonymized text too.
  const pseudonymize = pseudonymizer();
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
          const text = pseudonymize(value);
          if (
            safe(text) &&
            allowed.has(path) &&
            (path === 'payload.requirement'
              ? requirements.has(text)
              : /^[A-Za-z0-9_./:#@+-]+$/.test(text))
          )
            return text;
          return textPlaceholder(text);
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
