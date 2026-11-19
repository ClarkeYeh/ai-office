import { describe, expect, test } from 'vitest';
import {
  AttemptStateSchema,
  ExceptionKindSchema,
  MessageNudgePayloadSchema,
  PauseReasonSchema,
  WorkItemStatusSchema,
} from '@ai-office/contracts/events';
import { hasMessage, retainedTerms, t, zhTW } from './index.js';
import { officeMessagesZhTW } from './office.js';

describe('zh-TW catalog', () => {
  test.each([
    ['exception', ExceptionKindSchema.options],
    ['pause', PauseReasonSchema.options],
    ['office.attemptState', AttemptStateSchema.options],
    ['office.itemStatus', WorkItemStatusSchema.options],
    ['nudge', MessageNudgePayloadSchema.shape.reason.options],
  ] as const)('covers every %s enum member', (prefix, values) => {
    for (const value of values) {
      const key = `${prefix}.${value}`;
      expect(hasMessage(key), key).toBe(true);
      if (hasMessage(key)) expect(t(key).length).toBeGreaterThan(0);
    }
  });
  test('covers every M2 RuntimeWarning string (M2_PLAN §8.4)', () => {
    for (const warning of [
      'codex_env_filtered',
      'shim_folder_fallback',
      'version_changed',
      'host_slept',
      'orphan_resources',
      'chat_worker_identity_degraded',
    ])
      expect(hasMessage(`runtimeWarning.${warning}`), warning).toBe(true);
  });
  test('owns every office string and retains vocabulary', () => {
    for (const [key, value] of Object.entries(officeMessagesZhTW))
      expect(zhTW[key as keyof typeof officeMessagesZhTW]).toBe(value);
    expect(retainedTerms).toContain('Codex');
    expect(t('app.name')).toBe('AI Office');
  });
  test('interpolates values literally, preserves missing parameters, and rejects prototype keys', () => {
    expect(t('app.needs', { count: 0 })).toBe('需要你 0');
    expect(t('app.newGate', { title: '$& <script>' })).toBe(
      '$& <script>在等你',
    );
    expect(t('app.needs')).toBe('需要你 {count}');
    expect(
      t('app.needs', Object.create({ count: 42 }) as Record<string, number>),
    ).toBe('需要你 {count}');
    expect(hasMessage('toString')).toBe(false);
    expect(hasMessage('__proto__')).toBe(false);
    expect(hasMessage('future.key')).toBe(false);
  });
});
