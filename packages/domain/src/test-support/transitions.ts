import type { EventType } from '@ai-office/contracts/events';
import { expect, test } from 'vitest';
import type { DomainCommand } from '../commands.js';
import { Harness } from './fixtures.js';
import type { Step } from './fixtures.js';

/**
 * One row per state transition (M1-T6 acceptance). T9 / T10 append their rows
 * to this table in the same shape: `given` builds history through decide (or
 * hand-written event drafts), `when` is the command, `then` the emitted event
 * types (`[]` = idempotent no-op) or the rejection code.
 */
export interface TransitionRow {
  name: string;
  given: Step[] | ((harness: Harness) => Harness);
  when: DomainCommand;
  then: EventType[] | { error: string };
  check?: (harness: Harness) => void;
}

export const runTransitionRows = (rows: TransitionRow[]): void => {
  test.each(rows.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    const harness = new Harness();
    if (typeof row.given === 'function') row.given(harness);
    else harness.given(...row.given);
    const before = harness.events.length;
    const result = harness.run(row.when);
    if (Array.isArray(row.then)) {
      expect(result.ok ? undefined : result.error).toBeUndefined();
      expect(harness.events.slice(before).map((event) => event.type)).toEqual(
        row.then,
      );
      expect(harness.warnings).toEqual([]);
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(row.then.error);
    }
    row.check?.(harness);
  });
};
