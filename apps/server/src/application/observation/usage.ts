import type { Attempt } from '@ai-office/domain';
import type { UsageCursor } from '../../ports/refs.js';
import type { UsageRef, UsageSample } from '../../ports/usage.js';
import { Batch } from './batch.js';

type Tokens = Pick<
  UsageSample,
  'inputUncached' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning'
>;
export type UsageCheckpoint = {
  cursor: UsageCursor;
  sessionId: string;
  previous?: Tokens;
};
const fields = [
  'inputUncached',
  'output',
  'cacheRead',
  'cacheWrite',
  'reasoning',
] as const;
export const DEFAULT_BUDGET_FORMULA = 'inputUncached + output + cacheWrite';

/** A deliberately small arithmetic grammar: sums of counters, optionally weighted.
 * No eval; reject unsupported formulas at construction, before advancing cursors.
 */
export function budgetFormula(formula: string): (tokens: Tokens) => number {
  const terms = formula.split('+').map((term) => {
    const match =
      /^\s*(inputUncached|output|cacheRead|cacheWrite|reasoning)\s*(?:[*×]\s*(\d+(?:\.\d+)?))?\s*$/.exec(
        term,
      );
    if (!match) throw new Error('Invalid usage budget formula');
    const weight = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isFinite(weight))
      throw new Error('Invalid usage budget weight');
    return { field: match[1] as (typeof fields)[number], weight };
  });
  return (tokens) => {
    const result = Math.ceil(
      terms.reduce(
        (sum, term) => sum + (tokens[term.field] ?? 0) * term.weight,
        0,
      ),
    );
    if (!Number.isSafeInteger(result) || result < 0)
      throw new Error('Invalid budget token count');
    return result;
  };
}

export function ingestUsage(
  batch: Batch,
  attempt: Attempt,
  ref: UsageRef,
  samples: readonly UsageSample[],
  checkpoint: UsageCheckpoint | null,
  formula: (tokens: Tokens) => number,
): Tokens | undefined {
  let previous =
    checkpoint?.sessionId === ref.sessionId ? checkpoint.previous : undefined;
  for (const sample of samples) {
    for (const field of fields)
      if (
        sample[field] !== undefined &&
        (!Number.isSafeInteger(sample[field]) || sample[field]! < 0)
      )
        throw new Error('Invalid usage counter');
    // reasoning is a subset of output, not an extra component of total tokens.
    const total =
      sample.inputUncached +
      sample.output +
      sample.cacheRead +
      sample.cacheWrite;
    const key = sample.cumulative
      ? `usage:codex:${ref.sessionId}:${total}`
      : sample.externalKey;
    if (batch.has(key)) continue;
    if (
      sample.cumulative &&
      previous &&
      fields.some((field) => (sample[field] ?? 0) < (previous![field] ?? 0))
    )
      throw new Error('Cumulative usage regressed within a session');
    const tokens = Object.fromEntries(
      fields.flatMap((field) =>
        sample[field] === undefined
          ? []
          : [
              [
                field,
                sample[field]! -
                  (sample.cumulative ? (previous?.[field] ?? 0) : 0),
              ],
            ],
      ),
    ) as Tokens;
    batch.add(
      'usage.tokens',
      {
        attemptId: attempt.attemptId,
        ...tokens,
        budgetTokens: formula(tokens),
      },
      { externalKey: key, occurredAt: sample.occurredAt },
      'system',
      attempt,
      '',
    );
    if (sample.cumulative)
      previous = Object.fromEntries(
        fields.flatMap((field) =>
          sample[field] === undefined ? [] : [[field, sample[field]]],
        ),
      ) as Tokens;
  }
  return previous;
}
