import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { API_ERRORS, ErrorResponseSchema } from '@ai-office/contracts/api';
import { UseCaseError } from '../application/facade.js';
import { PortError } from '../ports/errors.js';
import { mapError, USE_CASE_ERRORS } from './errors.js';

// Scan error call sites as well as checking the table: new use-case errors must
// not silently fall back to 500. Include shared domain partitions called by T27.
const sources = [
  ...['commands', 'support'].map(
    (name) => `../application/use-cases/${name}.ts`,
  ),
  '../application/runner/runners.ts',
  ...['workflow', 'gate', 'question', 'support', 'workitem-drafts'].map(
    (name) => `../../../../packages/domain/src/decide/${name}.ts`,
  ),
];
const expected = new Map<string, { status: number; category: string }>();
for (const source of sources) {
  const text = readFileSync(new URL(source, import.meta.url), 'utf8');
  for (const match of text.matchAll(
    /(?:reject|domainError)\(\s*'([^']+)',\s*'([^']+)'/g,
  ))
    expected.set(match[2]!, {
      status: match[1] === 'conflict' ? 409 : 422,
      category: match[1]!,
    });
  for (const match of text.matchAll(/fail\(\s*(\d+),\s*'([^']+)'/g)) {
    const status = Number(match[1]);
    expected.set(match[2]!, {
      status,
      category:
        status === 503
          ? 'transient'
          : status === 404
            ? 'permanent'
            : status === 428
              ? 'guard'
              : status === 409
                ? 'conflict'
                : 'validation',
    });
  }
}
// Dynamic lookup failures and intentional public-contract translations.
for (const code of [
  'unknown_workflow',
  'unknown_gate',
  'unknown_question',
  'unknown_template',
  'unknown_repo',
])
  expected.set(code, { status: 404, category: 'permanent' });
expected.set('idempotency_mismatch', { status: 422, category: 'validation' });
expected.set('store_unavailable', { status: 503, category: 'transient' });

describe('use-case error translation', () => {
  it('covers every error call site, including dynamic entity lookup codes', () => {
    expect(expected.size).toBeGreaterThan(50);
    for (const [code, metadata] of expected) {
      expect(USE_CASE_ERRORS, code).toHaveProperty(code);
      const mapped = USE_CASE_ERRORS[code as keyof typeof USE_CASE_ERRORS];
      expect(API_ERRORS[mapped], code).toEqual(metadata);
    }
  });
  it.each(Object.entries(USE_CASE_ERRORS))(
    '%s maps to %s and its contract HTTP status',
    (source, target) => {
      const result = mapError(
        new UseCaseError(500, source, 'sensitive raw message', {
          token: 'secret',
        }),
      );
      expect(result.status).toBe(API_ERRORS[target].status);
      expect(result.body.error).toMatchObject({
        code: target,
        category: API_ERRORS[target].category,
      });
      expect(ErrorResponseSchema.safeParse(result.body).success).toBe(true);
      expect(JSON.stringify(result.body)).not.toMatch(/sensitive|secret/);
    },
  );
  it.each([
    ['transient', 503],
    ['rate_limited', 429],
    ['auth', 401],
    ['suspect_escalation', 503],
    ['identity', 503],
    ['hijacked', 409],
    ['contract_mismatch', 502],
    ['permanent', 422],
    ['bug', 500],
    ['conflict', 409],
    ['validation', 422],
    ['guard', 403],
  ] as const)(
    'maps %s adapter category to HTTP %s without exposing arbitrary codes',
    (category, status) => {
      const result = mapError(
        new PortError(category, 'adapter_private_code', 'sensitive', true),
      );
      expect(result.status).toBe(status);
      expect(API_ERRORS).toHaveProperty(result.body.error.code);
      expect(result.body.error.category).toBe(category);
    },
  );
  it('fails closed for unexpected failures and unmapped use-case codes', () => {
    for (const error of [
      new Error('secret'),
      new UseCaseError(409, 'new_unknown', 'secret'),
    ]) {
      expect(mapError(error)).toMatchObject({
        status: 500,
        body: { error: { code: 'internal_error', retryable: false } },
      });
    }
  });
});
