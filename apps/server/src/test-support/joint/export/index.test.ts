import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '@ai-office/contracts/events';
import {
  EVENT_STRING_ALLOWLIST,
  exportJointEvents,
  textPlaceholder,
} from './index.js';
const metadata = {
  exportedAt: '2026-11-24T00:00:00Z',
  aiOfficeCommit: 'a'.repeat(40),
  orcaVersion: '1.4.272',
};
describe('public joint export', () => {
  it('covers every event type and replaces unknown strings at every depth', () => {
    expect(Object.keys(EVENT_STRING_ALLOWLIST)).toEqual([...EVENT_TYPES]);
    const events = [
      {
        type: 'message.question',
        id: 'event-1',
        seq: 1,
        occurredAt: '2026-11-24T00:00:00Z',
        payload: {
          questionId: 'q1',
          body: 'Private question',
          unknown: { id: 'Private nested ID' },
          tokens: 42,
          ready: true,
        },
      },
      {
        type: 'future.event',
        payload: { id: 'unknown-id' },
        occurredAt: '2026-11-24T00:00:01Z',
      },
    ];
    const result = exportJointEvents(events, metadata);
    expect(result.events[0]).toMatchObject({
      type: 'message.question',
      id: 'event-1',
      occurredAt: '2000-01-01T00:00:00.000Z',
      payload: {
        questionId: 'q1',
        body: textPlaceholder('Private question'),
        unknown: { id: textPlaceholder('Private nested ID') },
        tokens: 42,
        ready: true,
      },
    });
    expect(result.events[1]).toMatchObject({
      type: textPlaceholder('future.event'),
      occurredAt: '2000-01-01T00:00:01.000Z',
      payload: { id: textPlaceholder('unknown-id') },
    });
    expect(events[0]?.payload.body).toBe('Private question');
  });
  it('preserves only caller-reviewed requirements and rejects secrets in structural fields', () => {
    const requirement = 'Build a tiny calculator.';
    const event = {
      type: 'workflow.started',
      payload: { requirement },
      externalKey: 'aio_ctl_synthetic_secret',
    };
    expect(exportJointEvents([event], metadata).events[0]).toMatchObject({
      payload: { requirement: textPlaceholder(requirement) },
      externalKey: textPlaceholder('aio_ctl_synthetic_secret'),
    });
    expect(
      exportJointEvents([event], { ...metadata, requirements: [requirement] })
        .events[0],
    ).toMatchObject({ payload: { requirement } });
  });
  it('never treats a known field from another event as approved', () => {
    expect(
      exportJointEvents(
        [{ type: 'meeting.statement', payload: { status: 'private' } }],
        metadata,
      ).events[0],
    ).toMatchObject({ payload: { status: textPlaceholder('private') } });
  });
});

it('retains template structure for budget replay without retaining role prose', () => {
  const event = {
    type: 'workflow.started',
    payload: {
      shortId: 'abc123',
      integrationBranch: 'ai-office/abc123-calc',
      templateSnapshot: {
        apiVersion: 'ai-office/v1alpha1',
        roles: {
          lead: { agent: 'claude-code', scope: 'Private instructions' },
        },
        stages: [
          {
            id: 'meeting',
            kind: 'meeting',
            facilitator: 'lead',
            participants: ['lead'],
            budget: { tokens: 1000 },
          },
        ],
      },
    },
  };
  expect(exportJointEvents([event], metadata).events[0]).toMatchObject({
    payload: {
      shortId: 'abc123',
      templateSnapshot: {
        apiVersion: 'ai-office/v1alpha1',
        roles: {
          lead: {
            agent: 'claude-code',
            scope: textPlaceholder('Private instructions'),
          },
        },
        stages: [
          {
            id: 'meeting',
            kind: 'meeting',
            facilitator: 'lead',
            participants: ['lead'],
            budget: { tokens: 1000 },
          },
        ],
      },
    },
  });
});
