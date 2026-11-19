import { WorkflowReadModelSchema } from '@ai-office/contracts/api';
import {
  DomainEventSchema,
  type DomainEvent,
  type EventPayload,
  type EventType,
} from '@ai-office/contracts/events';
import { evolve, type ReadModel } from '@ai-office/projection';
import {
  officeMessagesZhTW,
  type Translate,
} from '../../features/office/model/index.js';

// Hand-written event logs for office model tests (M4-T5 until the M4-T7 recorder
// produces fixtures/web/*.events.json). Every event is schema-checked and folded
// with the real projection, so tests see the read models the app will see.

export const WORKFLOW_ID = 'wf1';
export const T0 = Date.parse('2026-11-18T09:00:00Z');
export const iso = (ms: number) => new Date(ms).toISOString();
export const seatId = (role: string, itemKey?: string) =>
  [WORKFLOW_ID, role, itemKey].filter(Boolean).join(':');

const SHA = 'b'.repeat(64);
const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

export type TemplateOptions = { maxParallel?: number; finalGate?: boolean };

export function startPayload({
  maxParallel = 3,
}: TemplateOptions = {}): EventPayload<'workflow.started'> {
  const budget = { tokens: 1_000_000 };
  return {
    templateSnapshot: {
      apiVersion: 'ai-office/v1alpha1',
      id: 'default',
      name: 'Default',
      roles: {
        lead: { agent: 'claude-code' },
        pm: { agent: 'claude-code' },
        architect: { agent: 'claude-code' },
        engineer: { agent: 'codex' },
        integrator: { agent: 'claude-code' },
      },
      defaults: {
        integrationBranch: 'ai-office/{shortId}-{slug}',
        maxReruns: 2,
        budget: { hardLimitMultiplier: 2 },
      },
      stages: [
        {
          id: 'meeting',
          kind: 'meeting',
          facilitator: 'lead',
          participants: ['pm', 'architect', 'engineer'],
          maxRounds: 2,
          timeouts: { roundMin: 15, stageMin: 60 },
          budget,
          conclusion: { requireTechDecisions: true },
          gate: { id: 'conclusion', title: '結論定案' },
        },
        {
          id: 'planning',
          kind: 'planning',
          owner: 'lead',
          from: 'meeting',
          timeouts: { stageMin: 30 },
          budget,
          gate: { id: 'plan', title: '任務拆分' },
        },
        {
          id: 'implement',
          kind: 'implement',
          role: 'engineer',
          from: 'planning',
          maxParallel,
          timeouts: { itemMin: 45 },
          budget: { ...budget, perItem: { tokens: 400_000 } },
          onCall: { role: 'lead', questionTimeoutMin: 10 },
          mergeQueue: { role: 'integrator', reviewTimeoutMin: 20 },
          escalateOn: ['unresolvable-conflict'],
        },
        {
          id: 'integrate',
          kind: 'integrate',
          owner: 'lead',
          timeouts: { stageMin: 60 },
          budget,
        },
        {
          id: 'final-pr',
          kind: 'final-pr',
          maxRevisions: 2,
          gate: { id: 'final-pr', title: '最終 PR' },
        },
      ],
    },
    repo: {
      repoId: 'r1',
      localPath: '/repo',
      orcaRepoId: 'orca-1',
      github: { owner: 'octo', name: 'demo' },
      defaultBranch: 'main',
      visibility: 'public',
      ownerLogin: 'octo',
      defaultBranchProtected: 'unknown',
    },
    requirement: 'Add dark mode toggle',
    shortId: 'ab12',
    integrationBranch: 'ai-office/ab12-dark-mode',
    roleOverrides: {},
    gateToggles: {},
    budgets: { stages: {}, hardLimitMultiplier: 2 },
    limits: { globalAgents: 10 },
    acknowledgedUnverifiedRuntime: false,
  };
}

export type Log = ReturnType<typeof createLog>;

/** An event log with a clock: `tick(s)` advances it, `push` appends at the current time. */
export function createLog(options: TemplateOptions = {}) {
  const events: DomainEvent[] = [];
  const models: ReadModel[] = [];
  let model: ReadModel | null = null;
  let clock = T0;
  let commands = 0;
  const marks = new Map<string, number>();
  const markTimes = new Map<string, number>();

  function push<T extends EventType>(
    type: T,
    payload: EventPayload<T>,
  ): ReadModel {
    const e = DomainEventSchema.parse({
      seq: events.length + 1,
      id: ULID,
      occurredAt: iso(clock),
      recordedAt: iso(clock),
      workflowId: WORKFLOW_ID,
      source: 'engine',
      provenance: 'decided',
      schemaVersion: 1,
      type,
      payload,
    });
    events.push(e);
    model = evolve(model, e);
    if (!model) throw new Error(`no read model after ${type}`);
    WorkflowReadModelSchema.parse(model);
    models.push(model);
    return model;
  }

  const log = {
    events,
    /** Read model after each event, index = seq − 1. */
    models,
    get model(): ReadModel {
      return model!;
    },
    get now() {
      return clock;
    },
    tick(seconds = 1) {
      clock += seconds * 1000;
      return log;
    },
    push,
    /** Remembers the current seq under a name (golden checkpoints). */
    mark(name: string) {
      marks.set(name, events.length);
      markTimes.set(name, clock);
      return log;
    },
    at(name: string): ReadModel {
      const seq = marks.get(name);
      if (seq === undefined) throw new Error(`no mark ${name}`);
      return models[seq - 1]!;
    },
    /** Clock time when the mark was taken: the `now` the live view had then. */
    nowAt(name: string): number {
      const time = markTimes.get(name);
      if (time === undefined) throw new Error(`no mark ${name}`);
      return time;
    },
    marks,

    // -- shorthands ----------------------------------------------------------
    stage(stageId: string, kind: EventPayload<'stage.started'>['kind']) {
      push('stage.started', { stageId, kind, attempt: 1, mode: 'initial' });
      return log;
    },
    stageDone(stageId: string) {
      push('stage.completed', { stageId, attempt: 1 });
      return log;
    },
    spawn(p: {
      attemptId: string;
      role: string;
      stageId: string;
      purpose: EventPayload<'seat.spawned'>['purpose'];
      itemKey?: string;
      agent?: 'claude-code' | 'codex';
      attempt?: number;
      ondemand?: 'oncall' | 'merge';
      retryOf?: string;
    }) {
      push('seat.spawned', {
        seatId: seatId(p.role, p.itemKey),
        attemptId: p.attemptId,
        attempt: p.attempt ?? 1,
        stageId: p.stageId,
        role: p.role,
        agent: p.agent ?? (p.role === 'engineer' ? 'codex' : 'claude-code'),
        purpose: p.purpose,
        keepOpen: p.ondemand !== undefined,
        spawnCommandId: `c${++commands}`,
        ...(p.itemKey === undefined ? {} : { itemKey: p.itemKey }),
        ...(p.ondemand === undefined
          ? {}
          : { ondemand: { purpose: p.ondemand } }),
        ...(p.retryOf === undefined ? {} : { retryOf: p.retryOf }),
      });
      return log;
    },
    status(attemptId: string, state: EventPayload<'seat.status'>['state']) {
      push('seat.status', {
        attemptId,
        state,
        ...(state === 'waiting_input' ? { waitingSince: iso(clock) } : {}),
      });
      return log;
    },
    activity(
      attemptId: string,
      category: EventPayload<'seat.activity'>['activity'][number]['category'],
    ) {
      push('seat.activity', {
        attemptId,
        activity: [
          {
            messageId: `m${events.length + 1}`,
            category,
            inputLen: 1,
            outputLen: 1,
            inputHash: 'h',
          },
        ],
      });
      return log;
    },
    tokens(attemptId: string, budgetTokens: number) {
      push('usage.tokens', {
        attemptId,
        inputUncached: budgetTokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        budgetTokens,
      });
      return log;
    },
    exit(attemptId: string, release = true) {
      push('seat.exited', { attemptId, reason: 'done', expected: true });
      if (release) push('seat.released', { attemptId, removeWorkspace: false });
      return log;
    },
    stageGate(
      gateId: string,
      stageId: string,
      stageKind: 'meeting' | 'planning' | 'final-pr',
      title: string,
      content: EventPayload<'gate.opened'>['content'],
    ) {
      push('gate.opened', {
        gateId,
        stageId,
        kind: 'stage',
        templateGateId:
          stageKind === 'meeting'
            ? 'conclusion'
            : stageKind === 'planning'
              ? 'plan'
              : 'final-pr',
        stageKind,
        optional: false,
        title,
        options: [],
        content,
        version: 1,
      });
      return log;
    },
    exceptionGate(
      gateId: string,
      exceptionKind: Extract<
        EventPayload<'gate.opened'>,
        { kind: 'exception' }
      >['exceptionKind'],
      title: string,
      target: { itemKey?: string; attemptId?: string; questionId?: string },
    ) {
      push('gate.opened', {
        gateId,
        stageId: 'implement',
        kind: 'exception',
        exceptionKind,
        title,
        options: [{ optionId: 'proceed', label: 'Proceed' }],
        content: { type: 'exception', summary: title, ...target },
        version: 1,
      });
      return log;
    },
    decide(gateId: string, optionId?: string) {
      push('gate.decided', {
        gateId,
        decision: optionId === undefined ? 'approve' : 'option',
        by: 'user',
        version: 1,
        ...(optionId === undefined ? {} : { optionId }),
      });
      return log;
    },
    items(
      type: 'workitem.proposed' | 'workitem.approved',
      items: { key: string; deps?: string[] }[],
    ) {
      const drafts = items.map((i) => ({
        key: i.key,
        title: `Item ${i.key}`,
        body: 'Do it',
        acceptance: ['tests pass'],
        role: 'engineer',
        deps: i.deps ?? [],
        agent: 'codex' as const,
      }));
      if (type === 'workitem.proposed')
        push(type, {
          stageId: 'planning',
          submissionId: 'sub-plan',
          items: drafts,
        });
      else push(type, { gateId: 'g-plan', items: drafts });
      return log;
    },
    dispatch(itemKey: string, attemptId: string, attempt = 1) {
      log.spawn({
        attemptId,
        role: 'engineer',
        stageId: 'implement',
        purpose: 'worker',
        itemKey,
        attempt,
      });
      push('workitem.dispatched', {
        itemKey,
        attemptId,
        attempt,
        agent: 'codex',
        branch: `ai-office/ab12/${itemKey}`,
        workspaceName: `aio-ab12-${itemKey}-a${attempt}`,
      });
      return log;
    },
    itemStatus(
      itemKey: string,
      status: EventPayload<'workitem.status'>['status'],
      extra: Partial<EventPayload<'workitem.status'>> = {},
    ) {
      push('workitem.status', { itemKey, status, ...extra });
      return log;
    },
    openPr(itemKey: string, attemptId: string, pr: number) {
      push('artifact.created', {
        artifactId: `art-pr-${pr}`,
        kind: 'pr',
        number: pr,
        url: `https://github.com/octo/demo/pull/${pr}`,
        purpose: 'worker',
        head: `ai-office/ab12/${itemKey}`,
        base: 'ai-office/ab12-dark-mode',
        itemKey,
      });
      log.prStatus(pr, itemKey, 'open');
      log.itemStatus(itemKey, 'pr_open', { attemptId, pr });
      return log;
    },
    prStatus(pr: number, itemKey: string, state: 'open' | 'merged') {
      push('pr.status', {
        pr,
        state,
        base: 'ai-office/ab12-dark-mode',
        head: `ai-office/ab12/${itemKey}`,
        headSha: 'a'.repeat(40),
        mergeable: true,
      });
      return log;
    },
    queue(queue: string[], current?: string) {
      push('ondemand.queue_changed', {
        stageId: 'implement',
        purpose: 'merge',
        queue,
        ...(current === undefined ? {} : { current }),
      });
      return log;
    },
    mergeQueued(itemKey: string, attemptId: string, pr: number) {
      push('workitem.merge_queued', {
        itemKey,
        attemptId,
        pr,
        headSha: 'abcdef1',
      });
      return log;
    },
    merged(itemKey: string, pr: number) {
      log.prStatus(pr, itemKey, 'merged');
      push('workitem.merged', {
        itemKey,
        pr,
        mergeCommitSha: 'abcdef2',
        commandId: `c${++commands}`,
      });
      return log;
    },
  };
  push('workflow.started', startPayload(options));
  return log;
}

export const CONCLUSION_CONTENT = {
  type: 'conclusion' as const,
  artifactId: 'art-conclusion',
  renderedHash: SHA,
};

/** Deterministic translator: `key{"param":value}`, so assertions see what was asked. */
export const keyT: Translate = (key, params) =>
  params === undefined ? key : `${key}${JSON.stringify(params)}`;

/** zh-TW defaults from the model's message table, for readable fixtures. */
export const zhT: Translate = (key, params) =>
  officeMessagesZhTW[key].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params?.[name] ?? `{${name}}`),
  );
