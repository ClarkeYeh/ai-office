import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mapResponseError } from './errors.js';
const envelope = z.looseObject({ status: z.number(), response: z.unknown() });

describe('GitHub recorded error mappings', () => {
  it.each([
    ['g10-idempotency.duplicate-pr-422.json', 'github_validation', true],
    ['g10-idempotency.duplicate-ref-422.json', 'github_validation', true],
    ['g10-idempotency.no-commits-pr-422.json', 'github_validation', false],
    ['g4-merge.conflict-405.json', 'not_mergeable', undefined],
    ['g4-merge.stale-sha-409.json', 'head_mismatch', undefined],
  ])(
    'maps %s without retaining response details',
    (file, code, alreadyExists) => {
      const data = envelope.parse(
        JSON.parse(
          readFileSync(
            new URL(
              `../../../../../fixtures/github/2022-11-28/${file}`,
              import.meta.url,
            ),
            'utf8',
          ),
        ),
      );
      const error = mapResponseError(data.status, data.response, false);
      expect(error.code).toBe(code);
      expect(error.alreadyExists).toBe(alreadyExists);
      expect(error).not.toHaveProperty('errors');
      expect(error.message).not.toContain('ClarkeYeh');
    },
  );
});
