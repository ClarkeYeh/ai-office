import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentRef } from '../../../ports/refs.js';
import { RuntimeEventSchema } from '../../../ports/runtime-events.js';
import { parseResult } from '../schemas/index.js';
import { uuidV5 } from './cursor.js';
import {
  currentDispatch,
  dispatchOf,
  messageEvent,
  workerState,
} from './mapping.js';
import { isAnswer } from './observer.js';
import { detectRateLimit } from './rate-limit.js';
import {
  CheckResultSchema,
  InboxResultSchema,
  RequestShowSchema,
  WorkerListSchema,
  WorkerShowSchema,
} from './schemas.js';

function recorded(name: string): Record<string, unknown> {
  const file = JSON.parse(
    readFileSync(
      new URL(
        `../../../../../../fixtures/orca/1.4.259/${name}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { response: unknown };
  return parseResult(JSON.stringify(file.response));
}

describe('Orca 1.4.259 recordings', () => {
  it('parse with the observe schemas', () => {
    for (const name of [
      'check.wait.worker-done.ok',
      'check.batch-with-lost-escalation.ok',
      'after-restart.check.replayed.ok',
      'after-restart.check.consume-pre-restart-mail.ok',
    ])
      expect(CheckResultSchema.safeParse(recorded(name)).success).toBe(true);
    for (const name of [
      'inbox.run.full.ok',
      'inbox.dispatch.full.ok',
      'after-restart.inbox.run.full.ok',
    ])
      expect(InboxResultSchema.safeParse(recorded(name)).success).toBe(true);
    for (const name of [
      'worker-list.follow-up-retained.ok',
      'worker-list.reclaimable.ok',
      'worker-list.retained-after-150s.ok',
      'after-restart.worker-list.ok',
    ])
      expect(WorkerListSchema.safeParse(recorded(name)).success).toBe(true);
    expect(
      WorkerShowSchema.safeParse(recorded('worker-show.succeeded.ok')).success,
    ).toBe(true);
    expect(
      RequestShowSchema.parse(recorded('request-show.completed.ok')).state,
    ).toBe('completed');
  });

  it('check messages carry no sequence; inbox messages are newest-first by sequence', () => {
    const check = CheckResultSchema.parse(
      recorded('check.wait.worker-done.ok'),
    );
    expect(check.messages.every((m) => m.sequence === undefined)).toBe(true);
    const inbox = InboxResultSchema.parse(recorded('inbox.run.full.ok'));
    const seqs = inbox.messages.map((m) => m.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });

  it('maps a mixed batch: worker_done → agent.done, lost escalation → nothing', () => {
    const batch = CheckResultSchema.parse(
      recorded('check.batch-with-lost-escalation.ok'),
    );
    const events = batch.messages.map((m) =>
      messageEvent(m, dispatchOf(m) as AgentRef, 0),
    );
    expect(events[0]).toMatchObject({
      type: 'agent.done',
      outcome: 'success',
      externalKey: 'orca:msg:msg_cdf9848adccc',
      agent: 'ctx_8934904f1861',
    });
    expect(batch.messages[1]!.type).toBe('escalation');
    expect(events[1]).toBeNull();
    RuntimeEventSchema.parse(events[0]);
  });

  it('maps recorded questions with their payload text and message id', () => {
    const inbox = InboxResultSchema.parse(recorded('inbox.run.full.ok'));
    const question = inbox.messages.find((m) => m.type === 'question')!;
    expect(
      messageEvent(question, dispatchOf(question) as AgentRef, 0),
    ).toMatchObject({
      type: 'agent.question',
      question: question.id,
      agent: 'ctx_344f220389d5',
    });
  });

  it('chooses the resource owner of a follow-up chain; superseded rows are not exits', () => {
    const { workers } = WorkerListSchema.parse(
      recorded('worker-list.follow-up-retained.ok'),
    );
    const chain = workers.filter((w) =>
      ['ctx_344f220389d5', 'ctx_fbb183823fc4'].includes(w.dispatchId),
    );
    const current = currentDispatch([...chain].reverse());
    expect(current.dispatchId).toBe('ctx_344f220389d5');
    expect(workerState(current, false)).toBe('idle');
    const released = workers.find((w) => w.dispatchId === 'ctx_f91f0c1b897a')!;
    expect(workerState(released, false)).toBe('exited');
    const superseded = workers.find(
      (w) => w.dispatchId === 'ctx_fbb183823fc4',
    )!;
    expect(workerState(superseded, false)).not.toBe('exited');
  });

  it('reads the recorded agentWait as null after completion', () => {
    const shown = WorkerShowSchema.parse(recorded('worker-show.succeeded.ok'));
    expect(shown.observation?.agentWait).toBeNull();
    expect(detectRateLimit({ agentWait: shown.observation?.agentWait })).toBe(
      null,
    );
  });
});

describe('detectRateLimit', () => {
  it.each([
    ['Claude usage limit reached|1794990000', '2026-11-18T08:20:00.000Z'],
    ["You've hit your limit · resets 3pm (Asia/Taipei)", undefined],
    ["You've hit your usage limit. Try again at 3:15 PM.", undefined],
    [
      '5-hour limit reached ∙ resets 2026-11-18T09:00:00Z',
      '2026-11-18T09:00:00.000Z',
    ],
  ])('recognises %s', (text, resetsAt) => {
    expect(detectRateLimit({ lastMessage: text })).toEqual({
      evidence: 'transcript',
      ...(resetsAt ? { resetsAt } : {}),
    });
  });
  it('ignores ordinary messages and unrelated waits', () => {
    expect(
      detectRateLimit({ lastMessage: 'Tests pass; limit the scope.' }),
    ).toBe(null);
    expect(detectRateLimit({ agentWait: { kind: 'permission' } })).toBe(null);
  });
  it('prefers worker-show evidence', () => {
    expect(
      detectRateLimit({
        agentWait: { reason: 'usage_limit', resetsAt: 1794990000 },
        lastMessage: 'Claude usage limit reached',
      }),
    ).toEqual({
      evidence: 'worker-show',
      resetsAt: '2026-11-18T08:20:00.000Z',
    });
  });
});

it('uuidV5 matches RFC 4122 (DNS namespace sample)', () => {
  expect(
    uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
  ).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
});

describe('Orca 1.4.272 question notice (M5-FX-ORCA-OBS)', () => {
  const file = JSON.parse(
    readFileSync(
      new URL(
        '../../../../../../fixtures/orca/1.4.272/inbox.dispatch.question-notice.ok.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { response: unknown };
  const inbox = InboxResultSchema.parse(
    parseResult(JSON.stringify(file.response)),
  );
  const run = 'run_58fc91ed06c4';
  /** Orca's fixed notice (orcad-server `gps`, reason `unanswered`). */
  const NOTICE =
    'Your coordinator stopped without answering your question and has no worker running for it. Decide it yourself and say what you chose when you report. If an answer comes later, it still reaches you.';
  /** Our `runtime.answer` body: `aio:<tag>` line, then the answer. */
  const REPLY = 'aio:161bacce3a04a422\nBirch';
  const redacted = (text: string) =>
    `<redacted length=${text.length} sha256=${createHash('sha256').update(text).digest('hex')}>`;

  it('records the notice and our reply in the question thread, both from the run', () => {
    const [reply, notice] = inbox.messages;
    expect(reply!.thread_id).toBe(notice!.thread_id);
    expect([reply!.from_handle, notice!.from_handle]).toEqual([
      `run:${run}`,
      `run:${run}`,
    ]);
    // The recorded bodies are exactly these texts (pinned by sha256).
    expect(notice!.body).toBe(redacted(NOTICE));
    expect(reply!.body).toBe(redacted(REPLY));
    // The notice came first, in the second the question was asked.
    expect(notice!.created_at < reply!.created_at).toBe(true);
  });

  it('only our marked reply answers the question', () => {
    const [reply, notice] = inbox.messages;
    expect(isAnswer({ ...reply!, body: REPLY }, run)).toBe(true);
    expect(isAnswer({ ...notice!, body: NOTICE }, run)).toBe(false);
  });
});
