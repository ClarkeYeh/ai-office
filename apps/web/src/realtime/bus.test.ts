import { expect, test, vi } from 'vitest';
import { createAppliedBus } from './bus.js';
import { workflowStarted } from './test-support/events.js';

test('emits to every subscriber in order; a throwing one is isolated', async () => {
  const bus = createAppliedBus();
  const seen: string[] = [];
  const failure = new Error('boom');
  const reported = vi.fn();
  const onError = (error: unknown) => reported(error);
  process.on('uncaughtException', onError);
  bus.subscribe(() => {
    throw failure;
  });
  const off = bus.subscribe(() => seen.push('b'));
  const applied = {
    event: workflowStarted(1),
    prev: null,
    next: null,
    background: false,
  };
  bus.emit(applied);
  off();
  bus.emit(applied);
  expect(seen).toEqual(['b']);
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.off('uncaughtException', onError);
  expect(reported).toHaveBeenCalledWith(failure);
});
