import { createHash } from 'node:crypto';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type ApiClient } from '../../../api/index.js';
import {
  createRealtime,
  RealtimeProvider,
  type Realtime,
} from '../../../realtime/index.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { mainline } from '../../../test-support/office/mainline.js';
import type { GateView } from '../model/index.js';
import {
  CONCLUSION,
  EDITED,
  renderConclusion,
  withMarker,
} from '../test-support/conclusion.js';
import { GatePage } from './GatePage.js';

const log = mainline();
const model = log.at('gate:conclusion');
const base = model.gates.find((g) => g.gateId === 'g-conclusion')!;
const RENDERED = renderConclusion(CONCLUSION);
const GITHUB_RAW = withMarker(renderConclusion(EDITED));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function conclusionGate(
  patch: Partial<NonNullable<GateView['conclusion']>> = {},
  gate: Partial<GateView> = {},
): GateView {
  return {
    ...base,
    version: 2,
    ...gate,
    conclusion: {
      ...base.conclusion!,
      original: CONCLUSION,
      renderedBody: RENDERED,
      githubBody: GITHUB_RAW,
      githubBodyHash: 'c'.repeat(64),
      changedOnGithub: true,
      ...patch,
    },
  };
}
const conflict = (code: string) =>
  new ApiError(409, {
    code,
    category: 'conflict',
    retryable: false,
    message: code,
  });

let mobile = false;
beforeEach(() => {
  mobile = false;
  vi.stubGlobal('matchMedia', () => ({
    matches: mobile,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(gates: GateView | GateView[] | Error) {
  const queue = Array.isArray(gates) ? [...gates] : [gates];
  const getGate = vi.fn(() => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return next instanceof Error
      ? Promise.reject(next)
      : Promise.resolve(structuredClone(next));
  });
  const decideGate = vi.fn().mockResolvedValue({ accepted: true });
  const api = { getGate, decideGate } as unknown as ApiClient & {
    getGate: typeof getGate;
    decideGate: typeof decideGate;
  };
  const realtime: Realtime = createRealtime({
    api,
    openEventSource: () => {
      throw new Error('unexpected stream');
    },
    createWorker: () => {
      throw new Error('unexpected worker');
    },
  });
  realtime.store.setState({
    active: { workflowId: model.workflowId, live: model, status: 'ready' },
  });
  vi.spyOn(realtime.ticker, 'now').mockReturnValue(
    log.nowAt('gate:conclusion'),
  );
  const view = render(
    <RealtimeProvider realtime={realtime}>
      <GatePage route={{ params: { id: 'g-conclusion' } }} api={api} />
    </RealtimeProvider>,
  );
  return { api, realtime, view };
}
const ready = () =>
  waitFor(() =>
    expect(
      (screen.getByTestId('gate-approve') as HTMLButtonElement).disabled,
    ).toBe(false),
  );

describe('conclusion gate page', () => {
  test('shell: waiting status, facts, quiet office, needs and actions', async () => {
    setup(conclusionGate());
    await ready();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
      t('gates.heading.open', { title: base.title }),
    );
    expect(screen.getByTestId('gate-quiet').dataset.clear).toBe('true');
    expect(screen.getByTestId('gate-fact-version').textContent).toContain(
      t('gates.versionGithub', { version: 2 }),
    );
    expect(screen.getByTestId('gate-fact-reruns').textContent).toContain(
      t('gates.rerunsLeftValue', { count: 2 }),
    );
    expect(screen.getByTestId('gate-thumbnail')).toBeTruthy();
    expect(screen.getByTestId('gate-needs').textContent).toContain(
      t('gates.needs', { title: base.title }),
    );
    expect(screen.getByTestId('gate-back').getAttribute('href')).toBe(
      '/workflows/wf1',
    );
  });

  test('three views: GitHub (default), original, diff with GitHub additions marked', async () => {
    setup(conclusionGate());
    await ready();
    expect(screen.getByTestId('conclusion-callout').textContent).toBe(
      t('gates.conclusion.githubEdited'),
    );
    const github = screen.getByTestId('conclusion-panel-github');
    expect(github.textContent).toContain(
      'Apply saved theme before first paint',
    );
    expect(github.textContent).not.toContain('ai-office:cmd');
    const table = within(screen.getByTestId('conclusion-tech-table'));
    expect(
      table.getByText('CSS variables', { selector: 'strong' }),
    ).toBeTruthy();
    expect(
      screen.getByTestId('conclusion-issue-link').getAttribute('href'),
    ).toBe('https://github.com/octo/demo/issues/1');
    expect(screen.getByTestId('conclusion-statements').textContent).toContain(
      'architect position',
    );

    fireEvent.click(screen.getByTestId('conclusion-view-original'));
    expect(
      screen.getByTestId('conclusion-panel-original').textContent,
    ).not.toContain('Apply saved theme');
    expect(
      screen
        .getByTestId('conclusion-view-original')
        .getAttribute('aria-selected'),
    ).toBe('true');

    fireEvent.click(screen.getByTestId('conclusion-view-diff'));
    const added = screen
      .getByTestId('conclusion-diff')
      .querySelectorAll('[data-kind="added"]');
    expect([...added].map((li) => li.textContent).join('\n')).toContain(
      'Apply saved theme before first paint',
    );
    expect(screen.getByTestId('conclusion-diff').textContent).not.toContain(
      'ai-office:cmd',
    );
  });

  test('approve is one click with expectedVersion and the hash of the GitHub body shown', async () => {
    const { api } = setup(conclusionGate());
    await ready();
    fireEvent.click(screen.getByTestId('gate-approve'));
    await waitFor(() => expect(api.decideGate).toHaveBeenCalledOnce());
    const [gateId, body, options] = api.decideGate.mock.calls[0]!;
    expect(gateId).toBe('g-conclusion');
    expect(body).toEqual({
      decision: 'approve',
      expectedVersion: 2,
      githubBodyHash: sha(GITHUB_RAW),
    });
    expect(options.idempotencyKey).toMatch(/\S/);
    await waitFor(() =>
      expect(screen.getByTestId('gate-notice').textContent).toBe(
        t('gates.decided.approve'),
      ),
    );
    expect(api.getGate).toHaveBeenCalledTimes(2);
  });

  test('missing GitHub body: unavailable views, approval still possible with the known hash', async () => {
    const { api } = setup(
      conclusionGate({ githubBody: undefined, changedOnGithub: false }),
    );
    await ready();
    expect(screen.getByTestId('conclusion-callout').textContent).toBe(
      t('gates.conclusion.githubUnavailable'),
    );
    // Defaults to the original when GitHub cannot be read.
    expect(screen.getByTestId('conclusion-panel-original')).toBeTruthy();
    fireEvent.click(screen.getByTestId('conclusion-view-github'));
    expect(screen.getByTestId('conclusion-unavailable').textContent).toBe(
      t('gates.conclusion.githubUnavailable'),
    );
    fireEvent.click(screen.getByTestId('conclusion-view-diff'));
    expect(screen.getByTestId('conclusion-diff-unavailable')).toBeTruthy();
    fireEvent.click(screen.getByTestId('gate-approve'));
    await waitFor(() => expect(api.decideGate).toHaveBeenCalledOnce());
    expect(api.decideGate.mock.calls[0]![1].githubBodyHash).toBe(
      'c'.repeat(64),
    );
  });

  test('missing rendered body: diff unavailable, original falls back', async () => {
    setup(conclusionGate({ renderedBody: undefined, original: null }));
    await ready();
    fireEvent.click(screen.getByTestId('conclusion-view-original'));
    expect(screen.getByTestId('conclusion-unavailable').textContent).toBe(
      t('gates.conclusion.originalUnavailable'),
    );
    fireEvent.click(screen.getByTestId('conclusion-view-diff'));
    expect(screen.getByTestId('conclusion-diff-unavailable')).toBeTruthy();
  });

  test('unparseable GitHub body shows the full text', async () => {
    setup(
      conclusionGate({ githubBody: 'hand written\n<!-- ai-office:cmd=x -->' }),
    );
    await ready();
    expect(screen.getByTestId('conclusion-raw').textContent).toBe(
      'hand written',
    );
  });

  test('reject requires feedback, then sends it', async () => {
    const { api } = setup(conclusionGate());
    await ready();
    fireEvent.click(screen.getByTestId('gate-reject'));
    expect(screen.getByTestId('gate-feedback-error').textContent).toBe(
      t('gates.conclusion.feedbackRequired'),
    );
    expect(
      screen.getByTestId('gate-feedback').getAttribute('aria-invalid'),
    ).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('gate-feedback'));
    expect(api.decideGate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('gate-feedback'), {
      target: { value: '  Evaluate a third option  ' },
    });
    expect(screen.queryByTestId('gate-feedback-error')).toBeNull();
    fireEvent.click(screen.getByTestId('gate-reject'));
    await waitFor(() => expect(api.decideGate).toHaveBeenCalledOnce());
    expect(api.decideGate.mock.calls[0]![1]).toEqual({
      decision: 'reject',
      comment: 'Evaluate a third option',
      expectedVersion: 2,
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId('gate-feedback') as HTMLTextAreaElement).value,
      ).toBe(''),
    );
  });

  test('revise: edit from the GitHub version and send structured edits', async () => {
    const { api } = setup(conclusionGate());
    await ready();
    fireEvent.click(screen.getByTestId('gate-revise'));
    const summary = screen.getByTestId(
      'conclusion-edit-summary',
    ) as HTMLTextAreaElement;
    expect(summary.value).toBe(EDITED.summary);
    fireEvent.change(summary, { target: { value: 'New summary' } });
    fireEvent.change(screen.getByTestId('conclusion-edit-tech-0-chosen'), {
      target: { value: 'CSS-in-JS' },
    });
    fireEvent.click(screen.getByTestId('conclusion-edit-tech-add'));
    fireEvent.change(screen.getByTestId('conclusion-edit-tech-1-topic'), {
      target: { value: 'Storage' },
    });
    fireEvent.change(screen.getByTestId('conclusion-edit-tech-1-chosen'), {
      target: { value: 'localStorage' },
    });
    fireEvent.click(screen.getByTestId('gate-revise-submit'));
    await waitFor(() => expect(api.decideGate).toHaveBeenCalledOnce());
    const body = api.decideGate.mock.calls[0]![1];
    expect(body.decision).toBe('revise');
    expect(body.githubBodyHash).toBe(sha(GITHUB_RAW));
    expect(body.edits.conclusion.summary).toBe('New summary');
    expect(body.edits.conclusion.techDecisions).toEqual([
      { ...EDITED.techDecisions[0], chosen: 'CSS-in-JS' },
      { topic: 'Storage', options: [], chosen: 'localStorage', rationale: '' },
    ]);
    expect(body.edits.conclusion.decisions).toEqual(EDITED.decisions);
    await waitFor(() =>
      expect(screen.queryByTestId('conclusion-editor')).toBeNull(),
    );
  });

  test('revise editor: remove a tech row and cancel', async () => {
    setup(conclusionGate());
    await ready();
    fireEvent.click(screen.getByTestId('gate-revise'));
    fireEvent.click(screen.getByTestId('conclusion-edit-tech-0-remove'));
    expect(screen.queryByTestId('conclusion-edit-tech-0-topic')).toBeNull();
    fireEvent.click(screen.getByTestId('gate-revise-cancel'));
    expect(screen.queryByTestId('conclusion-editor')).toBeNull();
  });

  test('409 gate_content_changed: refetch, show the diff, ask again with a fresh key', async () => {
    const newer = withMarker(`${renderConclusion(EDITED)}\nlate edit`);
    const { api } = setup([
      conclusionGate(),
      conclusionGate({ githubBody: newer }, { version: 3 }),
    ]);
    api.decideGate.mockRejectedValueOnce(conflict('gate_content_changed'));
    await ready();
    fireEvent.click(screen.getByTestId('gate-approve'));
    await waitFor(() =>
      expect(screen.getByTestId('gate-notice').textContent).toBe(
        t('gates.error.contentChanged'),
      ),
    );
    expect(screen.getByTestId('gate-notice').getAttribute('role')).toBe(
      'alert',
    );
    await waitFor(() =>
      expect(
        screen
          .getByTestId('conclusion-view-diff')
          .getAttribute('aria-selected'),
      ).toBe('true'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('conclusion-diff').textContent).toContain(
        'late edit',
      ),
    );
    await ready();
    fireEvent.click(screen.getByTestId('gate-approve'));
    await waitFor(() => expect(api.decideGate).toHaveBeenCalledTimes(2));
    const [first, second] = api.decideGate.mock.calls;
    expect(second![1]).toMatchObject({
      expectedVersion: 3,
      githubBodyHash: sha(newer),
    });
    expect(second![2].idempotencyKey).not.toBe(first![2].idempotencyKey);
  });

  test('409 version_conflict: refetch and re-ask', async () => {
    const { api } = setup([
      conclusionGate(),
      conclusionGate({}, { version: 4 }),
    ]);
    api.decideGate.mockRejectedValueOnce(conflict('version_conflict'));
    await ready();
    fireEvent.click(screen.getByTestId('gate-approve'));
    await waitFor(() =>
      expect(screen.getByTestId('gate-notice').textContent).toBe(
        t('gates.error.versionConflict'),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('gate-fact-version').textContent).toContain(
        'v4',
      ),
    );
    expect(api.getGate).toHaveBeenCalledTimes(2);
  });

  test('a transport failure keeps the key for the resend of the same action', async () => {
    const { api } = setup(conclusionGate());
    api.decideGate.mockRejectedValueOnce(
      new ApiError(0, {
        code: 'network_error',
        category: 'transient',
        retryable: true,
        message: 'x',
      }),
    );
    await ready();
    fireEvent.click(screen.getByTestId('gate-approve'));
    await waitFor(() =>
      expect(screen.getByTestId('gate-notice').textContent).toBe(
        t('gates.error.network'),
      ),
    );
    await ready();
    fireEvent.click(screen.getByTestId('gate-approve'));
    await waitFor(() => expect(api.decideGate).toHaveBeenCalledTimes(2));
    const [first, second] = api.decideGate.mock.calls;
    expect(second![2].idempotencyKey).toBe(first![2].idempotencyKey);
  });

  test.each([
    [
      new ApiError(409, {
        code: 'gate_not_open',
        category: 'conflict',
        retryable: false,
        message: '',
      }),
      t('gates.error.notOpen'),
    ],
    [
      new ApiError(503, {
        code: 'scm_unavailable',
        category: 'transient',
        retryable: true,
        message: '',
      }),
      t('gates.error.scm'),
    ],
    [
      new ApiError(422, {
        code: 'snapshot_required',
        category: 'validation',
        retryable: false,
        message: '',
      }),
      t('gates.error.validation', { code: 'snapshot_required' }),
    ],
    [
      new ApiError(500, {
        code: 'internal',
        category: 'bug',
        retryable: false,
        message: '',
      }),
      t('gates.error.generic', { code: 'internal' }),
    ],
    [new Error('boom'), t('gates.error.network')],
  ])('maps decision errors to localized notices (%#)', async (error, text) => {
    const { api } = setup(conclusionGate());
    api.decideGate.mockRejectedValueOnce(error);
    await ready();
    fireEvent.click(screen.getByTestId('gate-approve'));
    await waitFor(() =>
      expect(screen.getByTestId('gate-notice').textContent).toBe(text),
    );
  });

  test('replay disables every decision control', async () => {
    const { api, realtime } = setup(conclusionGate());
    await ready();
    act(() =>
      realtime.store.setState({
        replay: {
          workflowId: 'wf1',
          eventCount: 1,
          seq: 1,
          model,
          loading: false,
          progress: 1,
        },
      }),
    );
    expect(screen.getByTestId('gate-read-only').textContent).toBe(
      t('gates.replayReadOnly'),
    );
    expect(
      (
        screen
          .getByTestId('gate-actions')
          .querySelector('fieldset') as HTMLFieldSetElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByTestId('gate-approve'));
    expect(api.decideGate).not.toHaveBeenCalled();
  });

  test('mobile: no thumbnail, decisions still available', async () => {
    mobile = true;
    setup(conclusionGate());
    await ready();
    expect(screen.queryByTestId('gate-thumbnail')).toBeNull();
    expect(screen.getByText(t('gates.mobile'))).toBeTruthy();
    expect(screen.getByTestId('gate-reject')).toBeTruthy();
  });

  test('decided gate: no actions, decided note', async () => {
    setup(
      conclusionGate(
        { renderedBody: undefined },
        {
          status: 'approved',
          decision: {
            decision: 'approve',
            by: 'user',
            at: new Date(log.nowAt('gate:conclusion')).toISOString(),
          },
        },
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('gate-decided-note')).toBeTruthy(),
    );
    expect(screen.queryByTestId('gate-actions')).toBeNull();
    expect(screen.queryByTestId('gate-needs')).toBeNull();
  });
});

describe('gate page shell states', () => {
  test('loading, then not found', async () => {
    setup(
      new ApiError(404, {
        code: 'not_found',
        category: 'permanent',
        retryable: false,
        message: '',
      }),
    );
    expect(screen.getByTestId('gate-status').textContent).toBe(
      t('gates.loading'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('gate-status').textContent).toBe(
        t('gates.notFound'),
      ),
    );
  });
  test('load failure', async () => {
    setup(new Error('down'));
    await waitFor(() =>
      expect(screen.getByTestId('gate-status').textContent).toBe(
        t('gates.loadFailed'),
      ),
    );
  });
  test('other gate kinds get the pending body until M4-T11b', async () => {
    setup({
      ...base,
      gateId: 'g-plan',
      content: { type: 'work-items', artifactId: 'a' },
      conclusion: undefined,
    } as GateView);
    await waitFor(() =>
      expect(screen.getByTestId('gate-body-pending')).toBeTruthy(),
    );
  });
  test('a refetch failure keeps the gate on screen with a notice', async () => {
    const { realtime } = setup([conclusionGate(), new Error('down') as never]);
    await ready();
    act(() =>
      realtime.store.setState({
        active: {
          workflowId: 'wf1',
          status: 'ready',
          live: {
            ...model,
            gates: model.gates.map((g) =>
              g.gateId === 'g-conclusion' ? { ...g, version: 9 } : g,
            ),
          },
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('gate-notice').textContent).toBe(
        t('gates.loadFailed'),
      ),
    );
    expect(screen.getByTestId('conclusion-document')).toBeTruthy();
  });
});
