import { RawAgentOutputSchema } from '../ports/runtime-events.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FakeClock,
  ManualScheduler,
  SeqIdGen,
  MemoryLogger,
  PassthroughRedactor,
} from './services.js';
describe('deterministic test services', () => {
  it('uses isolated clock values, explicit advancement and stable timer ordering', () => {
    const clock = new FakeClock(),
      seen: string[] = [],
      scheduler = new ManualScheduler(clock, (t) => seen.push(t.id));
    clock.now().setFullYear(2000);
    expect(clock.now().getUTCFullYear()).toBe(2026);
    scheduler.schedule({
      id: 'b',
      workflowId: 'wf',
      fireAt: '2026-01-01T00:00:01.000Z',
    });
    scheduler.schedule({
      id: 'a',
      workflowId: 'wf',
      fireAt: '2026-01-01T00:00:01.000Z',
    });
    scheduler.schedule({
      id: 'cancel',
      workflowId: 'wf',
      fireAt: clock.now().toISOString(),
    });
    scheduler.cancel('cancel');
    scheduler.runDue();
    expect(seen).toEqual([]);
    clock.advance(1000);
    expect(seen).toEqual([]);
    scheduler.runDue();
    scheduler.runDue();
    expect(seen).toEqual(['a', 'b']);
    expect(() => clock.advance(-1)).toThrow();
  });
  it('allows callbacks to cancel or replace other due timers', () => {
    const clock = new FakeClock(),
      seen: string[] = [],
      scheduler = new ManualScheduler(clock, (t) => {
        seen.push(t.id);
        scheduler.cancel('b');
      });
    for (const id of ['a', 'b'])
      scheduler.schedule({
        id,
        workflowId: 'wf',
        fireAt: clock.now().toISOString(),
      });
    scheduler.runDue();
    expect(seen).toEqual(['a']);
  });
  it('generates unique valid ULIDs and restart-stable UUIDv5 requests', () => {
    const ids = new SeqIdGen(),
      values = Array.from({ length: 1100 }, () => ids.ulid());
    expect(new Set(values).size).toBe(1100);
    for (const value of values)
      expect(z.ulid().safeParse(value).success).toBe(true);
    expect(ids.orcaRequestId('command')).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(ids.orcaRequestId('command')).toBe(
      new SeqIdGen().orcaRequestId('command'),
    );
    expect(ids.orcaRequestId('other')).not.toBe(ids.orcaRequestId('command'));
    expect(ids.shortId()).not.toBe(ids.shortId());
  });
  it('shares child logs while isolating bindings and inputs', () => {
    const logger = new MemoryLogger(),
      bindings = { workflowId: 'wf' },
      child = logger.child(bindings);
    bindings.workflowId = 'changed';
    const obj = { count: 1 };
    child.info(obj, 'message');
    obj.count = 2;
    logger.warn({});
    child.error({});
    expect(logger.entries.map((e) => e.level)).toEqual([
      'info',
      'warn',
      'error',
    ]);
    expect(logger.entries[0]).toEqual({
      level: 'info',
      bindings: { workflowId: 'wf' },
      obj: { count: 1 },
      msg: 'message',
    });
    const redactor = new PassthroughRedactor();
    expect(redactor.maskSecrets(obj)).toBe(obj);
    expect(
      redactor.toActivity(
        RawAgentOutputSchema.parse({
          type: 'agent.output',
          agent: 'agent',
          messageId: 'message',
          role: 'assistant',
          blocks: [],
          externalKey: 'output:1',
          occurredAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    ).toEqual({ activity: [], policyHits: [] });
  });
});
