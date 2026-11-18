import type { ReactNode } from 'react';
import { vi, type Mock } from 'vitest';
import { createApiClient, type ApiClient } from '../../../api/index.js';
import { createRealtime, RealtimeProvider } from '../../../realtime/index.js';
import { NavigationContext } from '../../../shared/ui/index.js';
import { startPayload } from '../../../test-support/office/log.js';
import type { RepoView, WorkflowSummary } from '@ai-office/contracts/api';

export function template() {
  const value = startPayload().templateSnapshot;
  for (const stage of value.stages)
    if ('gate' in stage && stage.kind !== 'final-pr')
      stage.gate.optional = true;
  return value;
}
export const repo: RepoView = {
  ...startPayload().repo,
  status: 'registered',
  issues: [],
  registeredAt: '2026-11-18T00:00:00Z',
  updatedAt: '2026-11-18T00:00:00Z',
};
export const workflow: WorkflowSummary = {
  workflowId: 'wf1',
  shortId: 'ab12',
  templateId: 'default',
  templateName: 'Default',
  repoId: 'r1',
  repoFullName: 'octo/demo',
  requirement: 'Build feature',
  status: 'running',
  pausedReasons: [],
  currentStageId: 'meeting',
  currentStageKind: 'meeting',
  progress: { stagesDone: 0, stagesTotal: 5 },
  openGates: 1,
  escalatedQuestions: 0,
  budgetTokens: 1234,
  startedAt: '2026-11-18T00:00:00Z',
};
type MockApi = ApiClient & {
  [
    K in
      | 'listTemplates'
      | 'getTemplate'
      | 'listRepos'
      | 'getRepo'
      | 'registerRepo'
      | 'listWorkflows'
      | 'startWorkflow'
      | 'cancelWorkflow'
      | 'cleanupWorkflow'
  ]: Mock<ApiClient[K]>;
};
export function setup(): {
  api: MockApi;
  realtime: ReturnType<typeof createRealtime>;
  navigate: Mock<(href: string) => void>;
  Wrapper: (props: { children: ReactNode }) => ReactNode;
} {
  globalThis.history.replaceState(null, '', '/workflows/new');
  const api = {
    ...createApiClient(),
    listTemplates: vi
      .fn()
      .mockResolvedValue({ valid: [template()], invalid: [] }),
    getTemplate: vi
      .fn()
      .mockResolvedValue({ valid: [template()], invalid: [] }),
    listRepos: vi.fn().mockResolvedValue({ repos: [repo] }),
    getRepo: vi.fn().mockResolvedValue(repo),
    registerRepo: vi.fn().mockResolvedValue(repo),
    listWorkflows: vi.fn().mockResolvedValue({ workflows: [] }),
    startWorkflow: vi.fn().mockResolvedValue({ workflowId: 'new-workflow' }),
    cancelWorkflow: vi.fn().mockResolvedValue({ accepted: true }),
    cleanupWorkflow: vi.fn().mockResolvedValue({ accepted: true }),
  };
  const realtime = createRealtime({
    api,
    openEventSource: () => {
      throw Error('unexpected stream');
    },
    createWorker: () => {
      throw Error('unexpected worker');
    },
  });
  const navigate = vi.fn();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <RealtimeProvider realtime={realtime}>
        <NavigationContext.Provider value={{ navigate }}>
          {children}
        </NavigationContext.Provider>
      </RealtimeProvider>
    );
  }
  return { api, realtime, navigate, Wrapper };
}
