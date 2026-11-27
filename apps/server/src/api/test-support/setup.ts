import type { InMemoryEventStore } from '../../test-support/stores.js';
import Fastify from 'fastify';
import { vi } from 'vitest';
import {
  harness,
  startWorkflow,
  repo,
} from '../../application/runner/test-support/harness.js';
import { createCommandFacade } from '../../application/facade.js';
import { SessionService } from '../../application/auth/session.js';
import {
  QueryService,
  ProjectionService,
  RepoCandidateQueries,
} from '../../application/queries/index.js';
import { TemplateQueries } from '../../application/queries/templates.js';
import { StreamService } from '../../application/stream/index.js';
import { draft } from '../../application/use-cases/support.js';
import {
  InMemorySessionStore,
  InMemoryProjectionStore,
} from '../../test-support/stores.js';
import {
  ManualScheduler,
  PassthroughRedactor,
} from '../../test-support/services.js';
import type { ReadModel } from '@ai-office/projection';
import type { TemplateRepository } from '../../ports/template.js';
import { registerApi, type ApiDependencies } from '../index.js';

export async function setup(
  options: { dev?: boolean; devOrigin?: string } = {},
) {
  const h = harness({ react: () => [] });
  const template = startWorkflow().template;
  const repository: TemplateRepository = {
    get: vi.fn(async (id) =>
      id === template.id
        ? template
        : id === 'invalid'
          ? {
              file: 'invalid.yaml',
              issues: [{ path: 'stages', message: 'Invalid stage' }],
            }
          : null,
    ),
    list: vi.fn(async () => ({ valid: [template], invalid: [] })),
  };
  h.world.runtime.health = vi.fn(async () => ({
    available: true,
    verified: true,
    version: '1',
    shim: 'ready' as const,
    ownership: 'owned' as const,
  }));
  h.world.runtime.inspectLocalRepo = vi.fn(async () => ({
    isGitMainWorktree: true,
    originUrl: 'git@github.com:octo/demo.git',
    runtimeRepoId: 'orca-repo-1',
  }));
  h.world.scm.inspectRepo = vi.fn(async () => ({
    defaultBranch: 'main',
    visibility: 'public' as const,
    viewerLogin: 'octo',
    defaultBranchProtected: true,
  }));
  h.store.append([draft(h.clock, null, 'repo.registered', repo())]);
  const commands = createCommandFacade({
    ...h,
    templates: repository,
    runtime: h.world.runtime,
    scm: h.world.scm,
    idempotency: (h.store as InMemoryEventStore).idempotency,
    redactor: new PassthroughRedactor(),
    limits: { globalAgents: 7 },
  });
  const projections = new ProjectionService(
    h.store,
    new InMemoryProjectionStore<ReadModel>(),
    h.clock,
    new ManualScheduler(h.clock, () => {}),
  );
  const queries = new QueryService(h.store, projections, 'fake');
  const sessionStore = new InMemorySessionStore(h.clock);
  const sessions = new SessionService(sessionStore);
  const token = sessions.exchangeBootstrapCode(
    sessionStore.issueBootstrapCode(),
  )!;
  const deps: ApiDependencies = {
    commands,
    queries,
    templates: new TemplateQueries(repository),
    candidates: new RepoCandidateQueries({
      runtime: h.world.runtime,
      scm: h.world.scm,
      registered: () => queries.listRepos().repos,
    }),
    sessions,
    stream: new StreamService(h.store),
    port: 4319,
    ...options,
  };
  const app = Fastify();
  await registerApi(app, deps);
  app.addHook('onClose', async () => projections.close());
  const headers = {
    host: '127.0.0.1:4319',
    origin: 'http://127.0.0.1:4319',
    cookie: `aio_session=${token}`,
  };
  return {
    ...h,
    app,
    deps,
    headers,
    token,
    sessionStore,
    repository,
    template,
  };
}
