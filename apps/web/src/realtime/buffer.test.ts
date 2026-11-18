import { expect, test } from 'vitest';
import { createEventBuffers } from './buffer.js';
import { healthChanged, usageTokens } from './test-support/events.js';

test('keeps the newest events per workflow and tracks what was evicted', () => {
  const buffers = createEventBuffers(3, 0);
  buffers.push(healthChanged(1));
  for (let seq = 2; seq <= 6; seq++) buffers.push(usageTokens(seq, 'a1'));
  buffers.push(usageTokens(7, 'a1', 'wf2'));
  expect(buffers.after('wf1', 0).map((e) => e.seq)).toEqual([4, 5, 6]);
  expect(buffers.after('wf1', 4).map((e) => e.seq)).toEqual([5, 6]);
  expect(buffers.after('nope', 0)).toEqual([]);
  expect(buffers.completeAfter('wf1')).toBe(3);
  expect(buffers.completeAfter('wf2')).toBe(0);
  buffers.raiseFloor(5);
  buffers.raiseFloor(2);
  expect(buffers.completeAfter('wf1')).toBe(5);
  expect(buffers.completeAfter('nope')).toBe(5);
  expect(createEventBuffers().completeAfter('x')).toBe(0);
});
