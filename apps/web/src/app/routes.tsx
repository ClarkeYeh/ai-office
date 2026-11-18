import type { ComponentType } from 'react';
import type { ApiClient } from '../api/index.js';
import type { RouteMatch, RouteName } from './router.js';
import { t, type MessageKey } from '../shared/lib/i18n/index.js';
import { Link, PixelFrame } from '../shared/ui/index.js';
import { useWebState } from '../realtime/index.js';
import { GatePage } from '../features/gates/index.js';

/** Feature entry components receive dependencies here; never import app/ from a feature. */
export interface RoutePageProps {
  route: RouteMatch;
  api: ApiClient;
}
export interface RouteDefinition {
  name: RouteName;
  title: MessageKey;
  Page: ComponentType<RoutePageProps>;
  /** Office content goes in Shell.office, never Shell.children. */
  office?: boolean;
}
function PendingPage() {
  return (
    <PixelFrame>
      <p>{t('app.pagePending')}</p>
    </PixelFrame>
  );
}
function HomePage() {
  const workflows = useWebState((state) => state.overview.workflows);
  return (
    <PixelFrame>
      <Link
        href="/workflows/new"
        aria-label={t('app.newWorkflow')}
        data-testid="new-workflow"
      >
        {t('app.newWorkflow')}
      </Link>
      {workflows.length ? (
        <ul>
          {workflows.map((workflow) => (
            <li key={workflow.workflowId}>
              <Link
                href={`/workflows/${encodeURIComponent(workflow.workflowId)}`}
                aria-label={workflow.requirement}
                data-testid={`workflow-${workflow.workflowId}`}
              >
                {workflow.requirement}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p>{t('app.noWorkflows')}</p>
      )}
    </PixelFrame>
  );
}
function NotFoundPage() {
  return (
    <PixelFrame>
      <p>{t('app.notFound')}</p>
    </PixelFrame>
  );
}
/** Replace the relevant Page with a feature's public index export as it lands. */
export const routes: readonly RouteDefinition[] = [
  { name: 'home', title: 'app.home', Page: HomePage },
  { name: 'newWorkflow', title: 'app.newWorkflow', Page: PendingPage },
  { name: 'workflow', title: 'app.office', Page: PendingPage, office: true },
  { name: 'board', title: 'app.board', Page: PendingPage },
  { name: 'timeline', title: 'app.timeline', Page: PendingPage },
  { name: 'gate', title: 'app.gate', Page: GatePage },
  { name: 'question', title: 'app.question', Page: PendingPage },
  { name: 'templates', title: 'app.templates', Page: PendingPage },
  { name: 'template', title: 'app.templates', Page: PendingPage },
  { name: 'repos', title: 'app.repos', Page: PendingPage },
  { name: 'notFound', title: 'app.notFound', Page: NotFoundPage },
];
