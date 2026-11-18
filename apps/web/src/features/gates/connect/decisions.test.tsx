import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import type { GateView, QuestionView } from '@ai-office/contracts/api';
import { ApiError, createApiClient } from '../../../api/index.js';
import { createRealtime, RealtimeProvider } from '../../../realtime/index.js';
import { useGateDecision } from './useGateDecision.js';
import { QuestionPage } from './QuestionPage.js';
import { GateBannerActions } from './GateBannerActions.js';
const gate: GateView = {
  gateId: 'g',
  workflowId: 'wf',
  stageId: 'plan',
  kind: 'stage',
  title: 'Plan',
  status: 'open',
  version: 2,
  openedAt: '2026-11-18T00:00:00Z',
  options: [],
  content: { type: 'work-items', artifactId: 'a' },
};
function setup() {
  const api = {
    ...createApiClient(),
    decideGate: vi.fn().mockResolvedValue({ accepted: true }),
    listQuestions: vi.fn().mockResolvedValue({ questions: [] }),
    answerQuestion: vi.fn().mockResolvedValue({ accepted: true }),
  };
  const realtime = createRealtime({
    api,
    openEventSource: () => {
      throw new Error('no stream');
    },
    createWorker: () => {
      throw new Error('no worker');
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RealtimeProvider realtime={realtime}>{children}</RealtimeProvider>
  );
  return { api, realtime, wrapper };
}
afterEach(cleanup);
test('all 409 errors refresh without retrying and preserve expectedVersion', async () => {
  const { api, wrapper } = setup();
  api.decideGate.mockRejectedValue(
    new ApiError(409, {
      code: 'gate_version_conflict',
      category: 'conflict',
      message: 'Changed',
      retryable: false,
    }),
  );
  const refetch = vi.fn();
  const { result } = renderHook(() => useGateDecision(gate, api, refetch), {
    wrapper,
  });
  await act(async () => {
    expect(
      await result.current.decide({ decision: 'approve' }, 'gates.done'),
    ).toBe(false);
  });
  expect(refetch).toHaveBeenCalledOnce();
  expect(api.decideGate).toHaveBeenCalledWith(
    'g',
    { decision: 'approve', expectedVersion: 2 },
    { idempotencyKey: expect.any(String) },
  );
  expect(result.current.conflicts).toBe(1);
});
test('replay blocks decisions at submit time, including retained callbacks', async () => {
  const { api, realtime, wrapper } = setup();
  const { result } = renderHook(() => useGateDecision(gate, api, vi.fn()), {
    wrapper,
  });
  const decide = result.current.decide;
  act(() =>
    realtime.store.setState({
      replay: {
        workflowId: 'wf',
        eventCount: 0,
        seq: 0,
        model: null,
        loading: true,
        progress: 0,
      },
    }),
  );
  expect(result.current.pending).toBe(true);
  await act(async () => {
    expect(await decide({ decision: 'approve' }, 'gates.done')).toBe(false);
  });
  expect(api.decideGate).not.toHaveBeenCalled();
});
test('uncertain transport retries reuse a key; duplicate clicks do not race', async () => {
  const { api, wrapper } = setup();
  api.decideGate.mockRejectedValueOnce(new Error('offline'));
  const { result } = renderHook(() => useGateDecision(gate, api, vi.fn()), {
    wrapper,
  });
  await act(async () => {
    await result.current.decide({ decision: 'approve' }, 'gates.done');
  });
  await act(async () => {
    await Promise.all([
      result.current.decide({ decision: 'approve' }, 'gates.done'),
      result.current.decide({ decision: 'approve' }, 'gates.done'),
    ]);
  });
  expect(api.decideGate).toHaveBeenCalledTimes(2);
  expect(api.decideGate.mock.calls[0]?.[2]).toEqual(
    api.decideGate.mock.calls[1]?.[2],
  );
});
const q: QuestionView = {
  questionId: 'q',
  workflowId: 'wf',
  seatId: 'seat',
  attemptId: 'a',
  role: 'engineer',
  body: 'Which?',
  status: 'escalated',
  askedAt: '2026-11-18T00:00:00Z',
};
test('question route answers through the answer endpoint and refetches conflicts', async () => {
  const { api, wrapper } = setup();
  api.listQuestions.mockResolvedValue({ questions: [q] });
  api.answerQuestion.mockRejectedValueOnce(
    new ApiError(409, {
      code: 'already_answered',
      category: 'conflict',
      message: 'Answered',
      retryable: false,
    }),
  );
  render(<QuestionPage route={{ params: { id: 'q' } }} api={api} />, {
    wrapper,
  });
  await waitFor(() =>
    expect(screen.getByTestId('question-answer')).toBeTruthy(),
  );
  fireEvent.change(screen.getByTestId('question-answer'), {
    target: { value: 'Use A' },
  });
  fireEvent.click(screen.getByTestId('question-submit'));
  await waitFor(() => expect(api.listQuestions).toHaveBeenCalledTimes(2));
  expect(api.answerQuestion).toHaveBeenCalledWith(
    'q',
    { body: 'Use A' },
    { idempotencyKey: expect.any(String) },
  );
  expect(api.decideGate).not.toHaveBeenCalled();
});

test('banner CTAs navigate to open exceptions and hide the live inbox during replay', () => {
  const { realtime, wrapper } = setup();
  realtime.store.setState((state) => ({
    overview: {
      ...state.overview,
      gates: [
        {
          ...gate,
          kind: 'exception',
          exceptionKind: 'hijacked',
          gateId: 'wf/gate',
        },
      ],
    },
  }));
  render(<GateBannerActions />, { wrapper });
  expect(
    screen.getByTestId('gate-banner-link-wf/gate').getAttribute('href'),
  ).toBe('/gates/wf%2Fgate');
  act(() =>
    realtime.store.setState({
      replay: {
        workflowId: 'wf',
        eventCount: 0,
        seq: 0,
        model: null,
        loading: true,
        progress: 0,
      },
    }),
  );
  expect(screen.queryByTestId('gate-banner-link-wf/gate')).toBeNull();
});
