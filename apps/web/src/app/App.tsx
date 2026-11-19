import {
  OfficeRightColumn,
  OfficeLegend,
  needsOf,
} from '../features/office/index.js';
import { SeatInspector } from '../features/seats/index.js';
import { useEffect, useState } from 'react';
import {
  useDisplayedModel,
  useNow,
  useRealtime,
  useWebState,
} from '../realtime/index.js';
import { t } from '../shared/lib/i18n/index.js';
import { Banner } from '../shared/ui/index.js';
import { AuthGate } from './AuthGate.js';
import { Banners } from './Banners.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { AppProviders, useAppServices, type AppServices } from './providers.js';
import { useRoute } from './router.js';
import { routes } from './routes.js';
import { Shell, type ShellNeed } from './Shell.js';
import { stageDone, stageGateOf } from './stageGates.js';

export function App({ services }: { services?: AppServices }) {
  return (
    <ErrorBoundary>
      <AppProviders {...(services ? { services } : {})}>
        <AuthGate>
          <RoutedApp />
        </AuthGate>
      </AppProviders>
    </ErrorBoundary>
  );
}
function RoutedApp() {
  const route = useRoute();
  const definition = routes.find((entry) => entry.name === route.name)!;
  const { api } = useAppServices();
  const realtime = useRealtime();
  const overview = useWebState((state) => state.overview);
  const active = useWebState((state) => state.active);
  const connection = useWebState((state) => state.connection);
  const replaying = useWebState((state) => state.replay !== null);
  const model = useDisplayedModel();
  const now = useNow();
  const [loadFailed, setLoadFailed] = useState(false);
  const workflowId = ['workflow', 'board', 'timeline'].includes(route.name)
    ? (route.params.id ?? null)
    : route.name === 'gate'
      ? (overview.gates.find((gate) => gate.gateId === route.params.id)
          ?.workflowId ?? null)
      : route.name === 'question'
        ? (overview.questions.find(
            (question) => question.questionId === route.params.id,
          )?.workflowId ?? null)
        : null;
  useEffect(() => {
    let disposed = false;
    setLoadFailed(false);
    // Replay must not leak into a different workflow or an unrelated page.
    if (realtime.store.getState().replay?.workflowId !== workflowId)
      realtime.replay.exit();
    void realtime.setActiveWorkflow(workflowId).catch(() => {
      if (!disposed) setLoadFailed(true);
    });
    return () => {
      disposed = true;
    };
  }, [realtime, workflowId]);
  useEffect(() => {
    document.title = `${t(definition.title)} · ${t('app.name')}`;
  }, [definition.title]);
  const openGates = overview.gates.filter((gate) => gate.status === 'open');
  const questions = overview.questions.filter(
    (question) => question.status === 'escalated',
  );
  const questionIds = new Set(questions.map((question) => question.questionId));
  const needs: ShellNeed[] = [
    ...(model
      ? needsOf(model, { now, t })
          .filter((need) => need.kind === 'seat')
          .map((need) => ({
            id: need.id,
            title: need.title,
            href: `/workflows/${encodeURIComponent(model.workflowId)}?seat=${encodeURIComponent(need.seatId!)}`,
          }))
      : []),
    ...openGates
      .filter((gate) => !gate.questionId || !questionIds.has(gate.questionId))
      .map((gate) => ({
        id: gate.gateId,
        title: gate.title,
        href: `/gates/${encodeURIComponent(gate.gateId)}`,
      })),
    ...questions.map((question) => ({
      id: question.questionId,
      title: t('office.need.question', { who: question.role }),
      href: `/questions/${encodeURIComponent(question.questionId)}`,
    })),
  ];
  const current = model?.workflowId === workflowId ? model : null;
  const view =
    route.name === 'board'
      ? 'board'
      : route.name === 'timeline'
        ? 'timeline'
        : 'office';
  const { Page } = definition;
  const page = loadFailed ? (
    <Banner tone="error">{t('app.loadFailed')}</Banner>
  ) : workflowId &&
    (active.workflowId !== workflowId || active.status === 'loading') ? (
    <p role="status" aria-busy="true">
      {t('app.loading')}
    </p>
  ) : workflowId && active.status === 'missing' ? (
    <p>{t('app.notFound')}</p>
  ) : (
    <Page route={route} api={api} />
  );
  return (
    <Shell
      title={current?.requirement ?? t(definition.title)}
      {...(current
        ? {
            templateName: current.template.name,
            integrationBranch: current.integrationBranch,
            elapsedMinutes: Math.max(
              0,
              Math.floor(
                ((current.endedAt ? Date.parse(current.endedAt) : now) -
                  Date.parse(current.startedAt)) /
                  60_000,
              ),
            ),
            totalTokens: current.usage.total.budgetTokens,
            budgetDisabled:
              'budgetEnforcement' in current.limits &&
              current.limits.budgetEnforcement === 'off',
          }
        : {})}
      {...(workflowId ? { workflowId } : {})}
      view={view}
      rightColumn={
        current && (route.name === 'workflow' || route.name === 'board') ? (
          <OfficeRightColumn
            inspector={(seatId) => <SeatInspector seatId={seatId} api={api} />}
          />
        ) : undefined
      }
      legend={<OfficeLegend />}
      needs={needs}
      newGateTitle={openGates.at(-1)?.title ?? ''}
      stages={
        current?.stages.map((stage) => {
          const gate = stageGateOf(current, stage.stageId);
          const done = stageDone(stage.status, gate);
          return {
            id: stage.stageId,
            name: t(`stage.${stage.kind}`),
            status: done ? 'done' : stage.status,
            current: stage.stageId === current.currentStageId,
            ...(gate ? { gate } : {}),
            // V3: the final-PR stage is its gate; one flag, not two chips.
            ...(stage.kind === 'final-pr' && gate ? { gateOnly: true } : {}),
            gates: current.gates
              .filter(
                (g) =>
                  g.stageId === stage.stageId &&
                  g.status === 'open' &&
                  g.gateId !== gate?.gateId,
              )
              .map((g) => ({
                id: g.gateId,
                title: g.title,
                href: `/gates/${encodeURIComponent(g.gateId)}`,
              })),
          };
        }) ?? []
      }
      banners={
        <Banners
          gateActions
          pausedReasons={current?.pausedReasons ?? []}
          health={overview.health}
          degraded={current?.seats.some((seat) => seat.degraded) ?? false}
          replaying={replaying}
          syncing={connection.catchingUp}
          connection={connection.status}
        />
      }
      {...(definition.office ? { office: page } : { children: page })}
    />
  );
}
