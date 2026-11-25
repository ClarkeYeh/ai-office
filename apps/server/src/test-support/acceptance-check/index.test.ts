import { describe, expect, it } from 'vitest';
import { exportJointEvents } from '../joint/export/index.js';
import type { AcceptanceFacts } from './facts.js';
import {
  checkAcceptance,
  eventsOf,
  formatReport,
  parseFacts,
} from './index.js';
import { syntheticMainline } from './synthetic.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped exported JSON
type Json = Record<string, any>;

const EXTERNAL = [
  'nf.cpu',
  'nf.fps',
  'nf.auth',
  'nf.boundaries',
  'nf.coverage',
  'x.engine-replay',
];
const masked = (events: Json[]) =>
  exportJointEvents(events, {
    exportedAt: '2026-11-24T00:00:00.000Z',
    aiOfficeCommit: 'a'.repeat(40),
    orcaVersion: '1.4.272',
  }).events as Json[];

/** Appends an event after the last one, keeping seq and ids unique. */
function append(
  events: Json[],
  type: string,
  payload: Json,
  envelope: Json = {},
) {
  const seq = events.at(-1)!.seq + 1;
  events.push({
    ...events.at(-1),
    seq,
    id: `01M5EXTRA${String(seq).padStart(17, '0')}`,
    externalKey: undefined,
    type,
    payload,
    ...envelope,
  });
}
const find = (
  events: Json[],
  type: string,
  match: (p: Json) => boolean = () => true,
) => events.find((e) => e.type === type && match(e.payload))!;
const drop = (events: Json[], type: string, match: (p: Json) => boolean) =>
  events.splice(events.indexOf(find(events, type, match)), 1);

type Break = (events: Json[], facts: AcceptanceFacts) => void;
/** One deliberate breakage per judged row (M5_PLAN §5 T10 acceptance). */
const BREAKS: Record<string, Break[]> = {
  'nf.latency': [
    (events) => {
      for (const e of events)
        if (e.source === 'runtime' && e.type === 'seat.status')
          e.recordedAt = new Date(
            Date.parse(e.occurredAt) + 5000,
          ).toISOString();
    },
  ],
  'nf.activity-latency': [
    (events) => {
      for (const e of events)
        if (e.source === 'runtime' && e.type === 'seat.activity')
          e.recordedAt = new Date(
            Date.parse(e.occurredAt) + 20_000,
          ).toISOString();
    },
  ],
  'nf.reliability': [
    (events) =>
      append(events, 'seat.spawned', {
        ...find(events, 'seat.spawned').payload,
      }),
    (events) =>
      drop(events, 'command.succeeded', (p) => p.kind === 'scm.mergePR'),
    (events) =>
      append(events, 'anomaly.detected', {
        kind: 'duplicate-object',
        severity: 'high',
      }),
    (events) =>
      append(events, 'command.reconciled', {
        commandId: 'x',
        kind: 'scm.openPR',
        outcome: 'gave_up',
      }),
    (_, facts) => (facts.markerScan = { maxObjectsPerCommand: 2 }),
  ],
  'nf.masking': [
    (events) =>
      (find(events, 'workflow.started').payload.note =
        'ghp_abcdefghijklmnopqrstuvwxyz0123'),
    (events) =>
      (find(events, 'workflow.started').payload.note = 'aio_ctl_0123456789'),
  ],
  'nf.merge-default-branch': [
    (events) =>
      append(events, 'command.issued', {
        commandId: 'merge-final',
        kind: 'scm.mergePR',
        args: { pr: { number: 20 } },
      }),
    (events) =>
      append(events, 'anomaly.detected', {
        kind: 'default-branch-moved',
        severity: 'high',
      }),
    (_, facts) => (facts.defaultBranchMovedOnlyByOwner = false),
  ],
  'nf.approve-comment': [
    (_, facts) => (facts.approveCommentNoStateChange = false),
  ],
  'nf.stage-gate-agents': [
    (events) =>
      drop(events, 'seat.released', (p) =>
        p.attemptId.endsWith('/planning/lead'),
      ),
  ],
  'v01.gates': [
    (events) => (find(events, 'gate.decided').payload.by = 'auto'),
    (events) => drop(events, 'gate.closed', () => true),
    (events) => drop(events, 'workflow.completed', () => true),
  ],
  'v01.oncall': [
    (events) => drop(events, 'ondemand.stopped', (p) => p.purpose === 'oncall'),
    (events) => (find(events, 'message.answered').payload.by = 'user'),
  ],
  'v01.base-sha': [
    (events, facts) => {
      delete facts.ancestry;
      find(
        events,
        'workitem.dispatched',
        (p) => p.itemKey === 'sub',
      ).payload.baseSha = '1'.padStart(40, '0');
    },
    (_, facts) =>
      (facts.ancestry = facts.ancestry!.map((f) => ({
        ...f,
        isAncestor: false,
      }))),
    (events) => drop(events, 'workitem.merged', (p) => p.itemKey === 'core'),
  ],
  'v01.rework': [
    (events) =>
      (find(events, 'workitem.merge_queued', (p) =>
        p.attemptId.endsWith('/mul/2/attempt'),
      ).payload.pr = 13),
    (events) =>
      delete find(
        events,
        'workitem.dispatched',
        (p) => p.reworkOf !== undefined,
      ).payload.reworkOf,
    (_, facts) => (facts.rework![0]!.firstHeadHasPending = false),
  ],
  'v01.integration-branch': [
    (events) =>
      append(events, 'anomaly.detected', {
        kind: 'integration-branch-moved',
        severity: 'high',
      }),
    (events) =>
      (find(
        events,
        'command.succeeded',
        (p) => p.kind === 'scm.mergePR',
      ).payload.result.mergeCommitSha = 'f'.repeat(40)),
    (_, facts) => facts.integrationFirstParent!.push('e'.repeat(40)),
  ],
  'v01.worker-list': [
    (_, facts) => (facts.workerListAtStageGates![1]!.liveAgents = 1),
    (_, facts) => facts.workerListAtStageGates!.pop(),
  ],
  'v01.waiting-input': [
    (events) =>
      (find(
        events,
        'seat.status',
        (p) => p.state === 'waiting_input',
      ).payload.state = 'working'),
  ],
  'v01.replay': [
    (events) => ([events[3], events[4]] = [events[4]!, events[3]!]),
    (events) => append(events, 'workflow.started', {}),
  ],
  'v01.usage': [
    (events) =>
      events.splice(
        0,
        events.length,
        ...events.filter((e) => e.type !== 'usage.tokens'),
      ),
    (events) =>
      (find(events, 'usage.tokens', (p) =>
        p.attemptId.endsWith('/mul/2/attempt'),
      ).externalKey = find(events, 'usage.tokens').externalKey),
    (events) =>
      append(events, 'budget.exceeded', {
        scope: 'workflow',
        metric: 'tokens',
        used: 2,
        budget: 1,
        threshold: 1,
      }),
  ],
  'v01.conflict': [
    (events) => drop(events, 'pr.status', (p) => p.mergeable === false),
    (events) => drop(events, 'workitem.merged', (p) => p.itemKey === 'sub'),
    (_, facts) => (facts.conflict![0]!.twoParentMerge = false),
  ],
  'x.no-duplicates': [
    (events) =>
      (events.filter((e) => e.type === 'seat.status')[1]!.externalKey =
        events.find((e) => e.type === 'seat.status')!.externalKey),
    (events) => (events[5]!.id = events[4]!.id),
    (events) =>
      append(events, 'command.issued', {
        ...find(events, 'command.issued').payload,
      }),
  ],
};

describe('§24 acceptance checker (M5-T10)', () => {
  it('passes every judged row on an m5-mainline-shaped log with full facts', () => {
    const { events, facts } = syntheticMainline();
    const report = checkAcceptance(events, facts);
    for (const r of report.rows)
      expect([r.id, r.verdict]).toEqual([
        r.id,
        EXTERNAL.includes(r.id) ? 'na' : 'pass',
      ]);
    expect(report.summary).toEqual({ pass: 18, fail: 0, na: 6 });
    expect(Object.keys(BREAKS).sort()).toEqual(
      report.rows
        .map((r) => r.id)
        .filter((id) => !EXTERNAL.includes(id))
        .sort(),
    );
  });

  it('judges the log alone, without facts (facts-only rows become N/A)', () => {
    const report = checkAcceptance(syntheticMainline().events);
    expect(
      report.rows.filter((r) => r.verdict !== 'pass').map((r) => r.id),
    ).toEqual([
      'nf.cpu',
      'nf.fps',
      'nf.auth',
      'nf.approve-comment',
      'nf.boundaries',
      'nf.coverage',
      'v01.worker-list',
      'x.engine-replay',
    ]);
    expect(report.summary.fail).toBe(0);
  });

  for (const [id, breaks] of Object.entries(BREAKS))
    breaks.forEach((breakIt, n) =>
      it(`turns ${id} ❌ on deliberate breakage ${n + 1}, and masking keeps the verdicts`, () => {
        const { events, facts } = syntheticMainline();
        breakIt(events, facts);
        const report = checkAcceptance(events, facts);
        const r = report.rows.find((x) => x.id === id)!;
        expect(r.verdict).toBe('fail');
        expect(r.evidence.some((e) => e.startsWith('FAIL '))).toBe(true);
        // A planted secret is exactly what the export removes.
        if (id !== 'nf.masking')
          expect(checkAcceptance(masked(events), facts)).toEqual(report);
      }),
    );

  it('gives a masked export the same verdicts and evidence as the raw log', () => {
    const { events, facts } = syntheticMainline();
    const exported = masked(events);
    expect(JSON.stringify(exported)).toContain('‹text len=');
    expect(checkAcceptance(exported, facts)).toEqual(
      checkAcceptance(events, facts),
    );
  });

  it('labels conflict paths B and C as variance', () => {
    const { events } = syntheticMainline();
    const conflict = find(events, 'pr.status', (p) => p.mergeable === false);
    const at = events.indexOf(conflict) + 1;
    events.splice(at, 0, {
      ...conflict,
      type: 'workitem.rework_requested',
      externalKey: undefined,
      id: '01M5EXTRA00000000000000000B',
      payload: { itemKey: 'sub', pr: 12, rework: 1 },
    });
    events.forEach((e, i) => (e.seq = i + 1));
    const b = checkAcceptance(events).rows.find(
      (r) => r.id === 'v01.conflict',
    )!;
    expect(b.verdict).toBe('pass');
    expect(b.evidence.join()).toMatch(/PR #12 \(sub\): path B.*\(variance\)/);
    events[at]!.type = 'gate.opened';
    events[at]!.payload = {
      kind: 'exception',
      exceptionKind: 'merge-blocked',
      content: { itemKey: 'sub' },
    };
    expect(
      checkAcceptance(events)
        .rows.find((r) => r.id === 'v01.conflict')!
        .evidence.join(),
    ).toMatch(/path C/);
  });

  describe('conflict from the PR status history (M5-T7b)', () => {
    const conflictRow = (events: Json[]) =>
      checkAcceptance(events).rows.find((r) => r.id === 'v01.conflict')!;
    const renumber = (events: Json[]) =>
      events.forEach((e, i) => (e.seq = i + 1));
    /** Moves sub's false status (plus a merged status) after the backend merge. */
    function lagged() {
      const { events } = syntheticMainline();
      const seen = find(events, 'pr.status', (p) => p.mergeable === false);
      events.splice(events.indexOf(seen), 1);
      const merged = find(
        events,
        'workitem.merged',
        (p) => p.itemKey === 'sub',
      );
      const at = events.indexOf(merged) + 2;
      events.splice(at, 0, seen, {
        ...seen,
        id: '01M5EXTRA0000000000000LAG01',
        externalKey: 'gh:pr:12:2',
        payload: { ...seen.payload, state: 'merged', mergeable: null },
      });
      renumber(events);
      return events;
    }

    it('accepts a lagged pr.status batch delivered after the merge', () => {
      const row = conflictRow(lagged());
      expect(row.verdict).toBe('pass');
      expect(row.evidence.join()).toMatch(/status ingested after the merge/);
    });

    it('fails a PR that never reported mergeable:false', () => {
      const { events } = syntheticMainline();
      drop(events, 'pr.status', (p) => p.mergeable === false);
      expect(conflictRow(events).verdict).toBe('fail');
    });

    it('fails a PR merged on the SCM side without a backend workitem.merged', () => {
      const events = lagged();
      drop(events, 'workitem.merged', (p) => p.itemKey === 'sub');
      const row = conflictRow(events);
      expect(row.verdict).toBe('fail');
      expect(row.evidence.join()).toMatch(/without a backend workitem.merged/);
    });

    it('fails a lagged false status when the PR history never shows the merge', () => {
      const events = lagged();
      drop(events, 'pr.status', (p) => p.pr === 12 && p.state === 'merged');
      expect(conflictRow(events).verdict).toBe('fail');
    });
  });

  it('accepts a bare array or the export envelope and refuses malformed input', () => {
    const { events } = syntheticMainline();
    expect(eventsOf(events)).toBe(events);
    expect(eventsOf({ exportedAt: 'x', events })).toBe(events);
    expect(() => eventsOf({ rows: [] })).toThrow(/event array/);
    expect(() => checkAcceptance([{ type: 'x' }])).toThrow(/seq/);
  });

  it('validates facts strictly', () => {
    const { facts } = syntheticMainline();
    expect(parseFacts(JSON.parse(JSON.stringify(facts)))).toEqual(facts);
    expect(() => parseFacts([])).toThrow(/object/);
    expect(() => parseFacts({ ancestory: [] })).toThrow(
      /Unknown GitHub fact: ancestory/,
    );
    expect(() =>
      parseFacts({ markerScan: { maxObjectsPerCommand: -1 } }),
    ).toThrow(/Malformed GitHub fact: markerScan/);
    expect(() =>
      parseFacts({
        ancestry: [
          { baseSha: 'main', commit: 'a'.repeat(40), isAncestor: true },
        ],
      }),
    ).toThrow(/ancestry/);
  });

  it('formats ✅ / ❌ / N/A lines with evidence and a summary', () => {
    const { events, facts } = syntheticMainline();
    facts.approveCommentNoStateChange = false;
    const text = formatReport(checkAcceptance(events, facts));
    expect(text).toMatch(/^✅ nf\.latency — /m);
    expect(text).toMatch(/^❌ nf\.approve-comment — /m);
    expect(text).toMatch(/^N\/A nf\.cpu — /m);
    expect(text).toMatch(
      /^ {4}FAIL facts\.approveCommentNoStateChange = false$/m,
    );
    expect(text.split('\n').at(-1)).toBe('17 ✅  1 ❌  6 N/A');
  });
});
