import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { GateView, QuestionView } from '@ai-office/contracts/api';
import { TaskSplitGate } from './TaskSplitGate.js';
import { ExceptionGate } from './ExceptionGate.js';
import { FinalPrGate } from './FinalPrGate.js';
import { Question } from './Question.js';
afterEach(cleanup);
const gate: GateView = {
  gateId: 'gate',
  workflowId: 'wf',
  stageId: 'plan',
  kind: 'stage',
  stageKind: 'planning',
  title: 'Plan',
  status: 'open',
  version: 1,
  openedAt: '2026-11-18T00:00:00Z',
  options: [],
  content: { type: 'work-items', artifactId: 'a' },
  editable: ['title', 'deps'],
  workItems: [
    {
      key: 'one',
      title: 'One',
      body: 'Body',
      acceptance: [],
      role: 'engineer',
      deps: [],
    },
  ],
};
test('task edits respect editable and send revised items; reject requires feedback', () => {
  const onDecision = vi.fn();
  render(
    <TaskSplitGate gate={gate} disabled={false} onDecision={onDecision} />,
  );
  expect(
    (screen.getByTestId('item-one-body') as HTMLTextAreaElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByTestId('tasks-reject') as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByTestId('item-one-title'), {
    target: { value: 'Changed' },
  });
  fireEvent.change(screen.getByTestId('item-one-deps'), {
    target: { value: 'missing' },
  });
  expect(
    (screen.getByTestId('tasks-approve') as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByTestId('item-one-deps'), {
    target: { value: '' },
  });
  fireEvent.click(screen.getByTestId('tasks-approve'));
  expect(onDecision).toHaveBeenCalledWith({
    decision: 'revise',
    edits: {
      type: 'work-items',
      items: [{ ...gate.workItems![0], title: 'Changed' }],
    },
  });
  fireEvent.change(screen.getByTestId('tasks-feedback'), {
    target: { value: 'Split further' },
  });
  fireEvent.click(screen.getByTestId('tasks-reject'));
  expect(onDecision).toHaveBeenLastCalledWith({
    decision: 'reject',
    comment: 'Split further',
  });
});
test.each([
  'budget-exceeded',
  'rework-limit',
  'dependency-blocked',
  'hijacked',
  'anomaly',
  'merge-blocked',
  'workitem-failed',
  'merge-review-failed',
  'stage-violation',
  'decision-request',
] as const)('%s renders offered actions and requires tokens', (kind) => {
  const onDecision = vi.fn();
  render(
    <ExceptionGate
      gate={{
        ...gate,
        kind: 'exception',
        exceptionKind: kind,
        content: { type: 'exception', summary: 'Details' },
        options: [{ optionId: 'top-up', label: 'Top up', input: 'tokens' }],
      }}
      disabled={false}
      onDecision={onDecision}
    />,
  );
  fireEvent.click(screen.getByTestId('option-top-up'));
  expect(
    (screen.getByTestId('option-submit') as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByTestId('option-input'), {
    target: { value: '200' },
  });
  fireEvent.click(screen.getByTestId('option-submit'));
  expect(onDecision).toHaveBeenCalledWith({
    decision: 'option',
    optionId: 'top-up',
    additionalTokens: 200,
  });
});
test('unknown and future exception kinds use title and available options', () => {
  render(
    <ExceptionGate
      gate={{
        ...gate,
        kind: 'exception',
        title: 'Future exception',
        options: [{ optionId: 'retry', label: 'Retry' }],
      }}
      disabled={true}
      onDecision={vi.fn()}
    />,
  );
  expect(screen.getByText('Future exception')).toBeTruthy();
  expect(
    (screen.getByTestId('option-submit') as HTMLButtonElement).disabled,
  ).toBe(true);
});
test('final PR offers human GitHub merge, revision and abort, never approve', () => {
  const onDecision = vi.fn();
  render(
    <FinalPrGate
      gate={{
        ...gate,
        content: { type: 'final-pr', artifactId: 'pr', pr: 7 },
        options: [
          { optionId: 'request-changes', label: 'Request changes' },
          { optionId: 'abort', label: 'Abort' },
        ],
      }}
      url="https://github.com/test/repo/pull/7"
      remaining={1}
      disabled={false}
      onDecision={onDecision}
    />,
  );
  expect(screen.getByTestId('final-pr-link').getAttribute('href')).toContain(
    '/pull/7',
  );
  expect(screen.queryByTestId('tasks-approve')).toBeNull();
  fireEvent.change(screen.getByTestId('final-feedback'), {
    target: { value: 'Fix checks' },
  });
  fireEvent.click(screen.getByTestId('final-reject'));
  expect(onDecision).toHaveBeenLastCalledWith({
    decision: 'reject',
    comment: 'Fix checks',
  });
  fireEvent.click(screen.getByTestId('final-abort'));
  expect(onDecision).toHaveBeenLastCalledWith({
    decision: 'option',
    optionId: 'abort',
  });
});
test('question submits option plus free text and disables in replay', () => {
  const q: QuestionView = {
    questionId: 'q',
    workflowId: 'wf',
    seatId: 'seat',
    attemptId: 'a',
    role: 'engineer',
    body: 'Which?',
    status: 'escalated',
    askedAt: '2026-11-18T00:00:00Z',
    escalation: {
      gateId: 'g',
      reason: 'timeout',
      at: '2026-11-18T00:00:00Z',
      options: [{ optionId: 'a', label: 'Choice A' }],
    },
  };
  const onAnswer = vi.fn();
  const { rerender } = render(
    <Question question={q} disabled={false} onAnswer={onAnswer} />,
  );
  fireEvent.change(screen.getByTestId('question-option'), {
    target: { value: 'a' },
  });
  fireEvent.change(screen.getByTestId('question-answer'), {
    target: { value: 'Use A' },
  });
  fireEvent.click(screen.getByTestId('question-submit'));
  expect(onAnswer).toHaveBeenCalledWith('Use A', 'a');
  rerender(<Question question={q} disabled={true} onAnswer={onAnswer} />);
  expect(
    (screen.getByTestId('question-submit') as HTMLButtonElement).disabled,
  ).toBe(true);
});

test('task additions and deletions preserve unique keys and detect broken dependencies', () => {
  const onDecision = vi.fn();
  render(
    <TaskSplitGate
      gate={{
        ...gate,
        editable: ['title', 'body', 'acceptance', 'role', 'agent', 'deps'],
      }}
      disabled={false}
      onDecision={onDecision}
    />,
  );
  fireEvent.change(screen.getByTestId('task-new-key'), {
    target: { value: 'one' },
  });
  expect((screen.getByTestId('task-add') as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.change(screen.getByTestId('task-new-key'), {
    target: { value: 'two' },
  });
  fireEvent.click(screen.getByTestId('task-add'));
  fireEvent.change(screen.getByTestId('item-two-deps'), {
    target: { value: 'one' },
  });
  fireEvent.click(screen.getByTestId('item-one-remove'));
  expect(
    (screen.getByTestId('tasks-approve') as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByTestId('item-two-deps'), {
    target: { value: '' },
  });
  fireEvent.change(screen.getByTestId('item-two-role'), {
    target: { value: 'engineer' },
  });
  fireEvent.click(screen.getByTestId('tasks-approve'));
  expect(onDecision.mock.calls[0]?.[0]).toMatchObject({
    decision: 'revise',
    edits: { items: [{ key: 'two', role: 'engineer' }] },
  });
});

test('final PR revision controls follow server options when the revision limit is reached', () => {
  render(
    <FinalPrGate
      gate={{
        ...gate,
        content: { type: 'final-pr', artifactId: 'pr' },
        options: [{ optionId: 'abort', label: 'Abort' }],
      }}
      remaining={null}
      disabled={false}
      onDecision={vi.fn()}
    />,
  );
  expect(
    (screen.getByTestId('final-feedback') as HTMLTextAreaElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByTestId('final-reject') as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByTestId('final-abort') as HTMLButtonElement).disabled,
  ).toBe(false);
});
