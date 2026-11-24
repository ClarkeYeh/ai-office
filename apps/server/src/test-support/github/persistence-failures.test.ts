import { expect, it, vi } from 'vitest';
import { PersistenceFailures, refusalReason } from './persistence-failures.js';
import { TapeLeakError } from './tape-normalization.js';

it('reports safe refusal reasons, preserving no raw error values', async () => {
  const failures = new PersistenceFailures();
  for (const [name, error] of [
    ['leak', new TapeLeakError('private value')],
    ['disk', Object.assign(new Error('private path'), { code: 'EEXIST' })],
    ['cleanup', new Error('Refusing to publish before successful cleanup')],
    ['unknown', new Error('private body')],
  ] as const)
    await failures.capture(name, async () => {
      throw error;
    });
  expect(() => failures.assertSuccess()).toThrow(
    'leak [tape leak scan], disk [filesystem EEXIST], cleanup [cleanup incomplete], unknown [unclassified persistence refusal]',
  );
  expect(refusalReason(null)).toBe('unclassified persistence refusal');
});
it('lists every affected case and total withheld responses at suite end', () => {
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const failures = new PersistenceFailures();
    failures.recordWithheld('first', 2);
    failures.recordWithheld('clean', 0);
    failures.recordWithheld('last', 1);
    failures.assertSuccess();
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'WITHHELD 3 response(s): first (2), last (1)',
    );
  } finally {
    report.mockRestore();
  }
});
