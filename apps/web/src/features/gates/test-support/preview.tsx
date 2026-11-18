// Static visual QA harness: no backend, credentials, or running workflow.
import { createRoot } from 'react-dom/client';
import type { GateView } from '@ai-office/contracts/api';
import { createApiClient } from '../../../api/index.js';
import { createRealtime, RealtimeProvider } from '../../../realtime/index.js';
import { t } from '../../../shared/lib/i18n/index.js';
import '../../../shared/ui/tokens.css';
import { gateHeaderViewModel } from '../model/index.js';
import { OtherGatePage } from '../connect/OtherGatePage.js';
const api = {
  ...createApiClient(),
  decideGate: async () => ({ accepted: true as const, commandId: 'preview' }),
};
const realtime = createRealtime({
  api,
  openEventSource: () => {
    throw new Error('preview only');
  },
  createWorker: () => {
    throw new Error('preview only');
  },
});
const base: GateView = {
  gateId: 'preview',
  workflowId: 'preview',
  stageId: 'planning',
  kind: 'stage',
  stageKind: 'planning',
  title: t('gates.tasks.title'),
  status: 'open',
  version: 1,
  openedAt: '2026-11-18T00:00:00Z',
  options: [],
  content: { type: 'work-items', artifactId: 'items' },
  editable: ['title', 'body', 'acceptance', 'role', 'agent', 'deps'],
  workItems: [
    {
      key: 'theme',
      title: 'Theme preferences',
      body: 'Apply the saved theme before first paint.',
      acceptance: ['Keyboard accessible', 'Preserves the saved preference'],
      role: 'engineer',
      agent: 'codex',
      deps: [],
    },
    {
      key: 'settings',
      title: 'Settings controls',
      body: 'Add the theme selection to settings.',
      acceptance: ['Works on mobile'],
      role: 'engineer',
      agent: 'claude-code',
      deps: ['theme'],
    },
  ],
};
const gate: GateView =
  location.hash === '#exception'
    ? {
        ...base,
        kind: 'exception',
        exceptionKind: 'rework-limit',
        title: t('exception.rework-limit'),
        content: {
          type: 'exception',
          summary: 'Review needs another attempt.',
        },
        options: [
          { optionId: 'retry', label: 'Retry' },
          { optionId: 'reassign', label: 'Reassign', input: 'agent' },
          { optionId: 'abort', label: 'Abort' },
        ],
      }
    : location.hash === '#final'
      ? {
          ...base,
          stageKind: 'final-pr',
          title: 'PR #42',
          content: { type: 'final-pr', artifactId: 'pr', pr: 42 },
          pr: {
            number: 42,
            purpose: 'final',
            state: 'open',
            head: 'integration/demo',
            base: 'main',
            headSha: 'a'.repeat(40),
            mergeable: true,
            checks: 'success',
            url: 'https://github.com/example/demo/pull/42',
            updatedAt: base.openedAt,
          },
          options: [
            { optionId: 'request-changes', label: 'Request changes' },
            { optionId: 'keep-open', label: 'Keep open' },
            { optionId: 'abort', label: 'Abort' },
          ],
        }
      : base;
createRoot(document.getElementById('root')!).render(
  <RealtimeProvider realtime={realtime}>
    <OtherGatePage
      gate={gate}
      model={null}
      api={api}
      refetch={() => {}}
      layout={{
        header: gateHeaderViewModel(gate, null, {
          now: Date.parse('2026-11-18T00:03:00Z'),
          t,
        }),
        backHref: '/',
      }}
    />
  </RealtimeProvider>,
);
