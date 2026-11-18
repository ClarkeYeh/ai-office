import {
  WorkflowsPage,
  StartWorkflowPage,
} from '../features/workflows/index.js';
import { TemplatesPage } from '../features/templates/index.js';
import { ReposPage } from '../features/repos/index.js';
import { TimelinePage } from '../features/timeline/index.js';
import type { ComponentType } from 'react';
import type { ApiClient } from '../api/index.js';
import type { RouteMatch, RouteName } from './router.js';
import { t, type MessageKey } from '../shared/lib/i18n/index.js';
import { PixelFrame } from '../shared/ui/index.js';
import { GatePage, QuestionPage } from '../features/gates/index.js';

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
function NotFoundPage() {
  return (
    <PixelFrame>
      <p>{t('app.notFound')}</p>
    </PixelFrame>
  );
}
/** Replace the relevant Page with a feature's public index export as it lands. */
export const routes: readonly RouteDefinition[] = [
  { name: 'home', title: 'app.home', Page: WorkflowsPage },
  { name: 'newWorkflow', title: 'app.newWorkflow', Page: StartWorkflowPage },
  { name: 'workflow', title: 'app.office', Page: PendingPage, office: true },
  { name: 'board', title: 'app.board', Page: PendingPage },
  { name: 'timeline', title: 'app.timeline', Page: TimelinePage },
  { name: 'gate', title: 'app.gate', Page: GatePage },
  { name: 'question', title: 'app.question', Page: QuestionPage },
  { name: 'templates', title: 'app.templates', Page: TemplatesPage },
  { name: 'template', title: 'app.templates', Page: TemplatesPage },
  { name: 'repos', title: 'app.repos', Page: ReposPage },
  { name: 'notFound', title: 'app.notFound', Page: NotFoundPage },
];
