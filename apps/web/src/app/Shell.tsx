import { OfficeUsage } from '../features/office/index.js';
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { hasMessage, t } from '../shared/lib/i18n/index.js';
import { Button, Link, PixelFrame, PixelIcon } from '../shared/ui/index.js';
import styles from './shell.module.css';
export interface ShellNeed {
  id: string;
  title: string;
  href: string;
}
/** A stage's template gate in the strip: a muted flag, the open gate, or a check. */
export interface ShellStageGate {
  id: string;
  title: string;
  state: 'pending' | 'open' | 'done';
  /** The open gate instance and its page. */
  gateId?: string;
  href?: string;
}
export interface ShellStage {
  id: string;
  name: string;
  status: string;
  current?: boolean;
  gate?: ShellStageGate;
  /** The stage is its gate (final PR): draw only the gate chip. */
  gateOnly?: boolean;
  /** Other open gates of the stage (exceptions). */
  gates?: readonly ShellNeed[];
}
export interface ShellProps {
  title?: string;
  templateName?: string;
  integrationBranch?: string;
  elapsedMinutes?: number;
  workflowId?: string;
  view?: 'office' | 'board' | 'timeline';
  needs?: readonly ShellNeed[];
  stages?: readonly ShellStage[];
  totalTokens?: number;
  budgetDisabled?: boolean;
  banners?: ReactNode;
  children?: ReactNode;
  /** Office content must be supplied here so it is never mounted below 900px. */
  office?: ReactNode;
  rightColumn?: ReactNode;
  legend?: ReactNode;
  newGateTitle?: string;
}
const subscribeLocation = (listener: () => void) => {
  globalThis.addEventListener('popstate', listener);
  return () => globalThis.removeEventListener('popstate', listener);
};
const mobileQuery = '(max-width: 899px)';
function subscribeMobile(listener: () => void) {
  const query = globalThis.matchMedia(mobileQuery);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
export function Shell({
  title,
  templateName,
  integrationBranch,
  elapsedMinutes,
  workflowId,
  view = 'office',
  needs = [],
  stages = [],
  totalTokens,
  budgetDisabled,
  banners,
  children,
  office,
  rightColumn,
  legend,
  newGateTitle,
}: ShellProps) {
  const search = useSyncExternalStore(
    subscribeLocation,
    () => globalThis.location.search,
    () => '',
  );
  const mobile = useSyncExternalStore(
    subscribeMobile,
    () => globalThis.matchMedia(mobileQuery).matches,
    () => true,
  );
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    setAnnouncement(t('app.needs', { count: needs.length }));
  }, [needs.length]);
  const workflowPath = workflowId
    ? `/workflows/${encodeURIComponent(workflowId)}`
    : null;
  return (
    <div className={styles.shell}>
      <a
        href="#main-content"
        aria-label={t('app.skip')}
        data-testid="skip-content"
        className={styles.skip}
      >
        {t('app.skip')}
      </a>
      <header className={styles.header}>
        <Link
          href="/"
          aria-label={t('app.name')}
          data-testid="home-link"
          className={styles.brand}
        >
          <PixelIcon name="office" />
          {t('app.name')}
        </Link>
        <div className={styles.heading}>
          <h1 className={styles.title}>{title ?? t('app.home')}</h1>
          <div className={styles.meta}>
            {templateName && (
              <span>{t('app.template', { name: templateName })}</span>
            )}
            {integrationBranch && (
              <span>{t('app.branch', { branch: integrationBranch })}</span>
            )}
            {elapsedMinutes !== undefined && (
              <span>{t('app.elapsed', { minutes: elapsedMinutes })}</span>
            )}
          </div>
        </div>
        {workflowPath ? (
          <nav aria-label={t('app.view')} className={styles.views}>
            {(['office', 'board', 'timeline'] as const).map((mode) => (
              <Link
                key={mode}
                href={`${workflowPath}${mode === 'office' ? '' : `/${mode}`}${search}`}
                aria-label={t(`app.${mode}`)}
                data-testid={`view-${mode}`}
                aria-current={view === mode ? 'page' : undefined}
              >
                {t(`app.${mode}`)}
              </Link>
            ))}
          </nav>
        ) : (
          <nav aria-label={t('app.navigation')} className={styles.navigation}>
            <Link
              href="/templates"
              aria-label={t('app.templates')}
              data-testid="nav-templates"
            >
              {t('app.templates')}
            </Link>
            <Link
              href="/repos"
              aria-label={t('app.repos')}
              data-testid="nav-repos"
            >
              {t('app.repos')}
            </Link>
          </nav>
        )}
        <Button
          variant={needs.length ? 'need' : 'secondary'}
          aria-label={t('app.needs', { count: needs.length })}
          data-testid="needs-button"
          onClick={() => document.getElementById('needs-you')?.focus()}
        >
          {t('app.needs', { count: needs.length })}
        </Button>
      </header>
      {stages.length > 0 && (
        <nav className={styles.flow} aria-label={t('app.stages')}>
          <span className={styles.flowLabel} aria-hidden="true">
            {t('app.flow')}
          </span>
          <ol className={styles.stages} data-testid="stage-strip">
            {stages.map((stage) => {
              const key = `stage.${stage.status}`;
              const gate = stage.gate;
              // V3: while a stage's gate waits, the gate chip is the current step.
              const gateCurrent =
                stage.current === true &&
                (stage.gateOnly === true || gate?.state === 'open');
              return (
                <li key={stage.id} className={styles.stage}>
                  {!stage.gateOnly && (
                    <span
                      className={styles.stageLabel}
                      data-testid={`stage-${stage.id}`}
                      data-status={stage.status}
                      aria-current={
                        stage.current && !gateCurrent ? 'step' : undefined
                      }
                      aria-label={t('stage.aria', {
                        name: stage.name,
                        status: hasMessage(key) ? t(key) : stage.status,
                      })}
                    >
                      {stage.status === 'done' && <PixelIcon name="check" />}
                      {stage.name}
                    </span>
                  )}
                  {gate && !stage.gateOnly && (
                    <span className={styles.dash} aria-hidden="true" />
                  )}
                  {gate &&
                    (gate.state === 'open' && gate.href ? (
                      <Link
                        href={gate.href}
                        aria-label={t('stage.gate.open', { title: gate.title })}
                        data-testid={`stage-gate-${gate.gateId}`}
                        data-state="open"
                        aria-current={gateCurrent ? 'step' : undefined}
                      >
                        <PixelIcon name="flag" />
                        {gate.title}
                      </Link>
                    ) : (
                      <span
                        className={styles.stageGate}
                        data-testid={`stage-flag-${gate.id}`}
                        data-state={gate.state}
                        aria-current={gateCurrent ? 'step' : undefined}
                        aria-label={t(`stage.gate.${gate.state}`, {
                          title: gate.title,
                        })}
                      >
                        <PixelIcon
                          name={gate.state === 'done' ? 'check' : 'flag'}
                        />
                        {gate.title}
                      </span>
                    ))}
                  {stage.gates?.map((other) => (
                    <Link
                      key={other.id}
                      href={other.href}
                      aria-label={other.title}
                      data-testid={`stage-gate-${other.id}`}
                    >
                      <PixelIcon name="flag" />
                      {other.title}
                    </Link>
                  ))}
                </li>
              );
            })}
          </ol>
        </nav>
      )}
      {banners}
      <div className={styles.body}>
        <main id="main-content" tabIndex={-1} className={styles.content}>
          {children}
          {office !== undefined &&
            (mobile ? (
              <p className={styles.muted} data-testid="mobile-office-message">
                {t('app.mobile')}
              </p>
            ) : (
              <>
                {office}
                {legend}
              </>
            ))}
        </main>
        <aside aria-label={t('app.sidebar')} className={styles.sidebar}>
          <PixelFrame
            attention={needs.length > 0}
            id="needs-you"
            tabIndex={-1}
            data-testid="needs-panel"
          >
            <h2 className={styles.needsTitle}>
              {t('app.needs', { count: needs.length })}
            </h2>
            {needs.length ? (
              <ul className={styles.needsList}>
                {needs.map((need) => (
                  <li key={need.id}>
                    <Link
                      href={need.href}
                      aria-label={need.title}
                      data-testid={`need-${need.id}`}
                    >
                      {need.title}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.muted}>{t('app.needsEmpty')}</p>
            )}
          </PixelFrame>
          {rightColumn}
          {totalTokens !== undefined && (
            <OfficeUsage
              totalTokens={totalTokens}
              budgetDisabled={budgetDisabled ?? false}
            />
          )}
        </aside>
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={styles.srOnly}
        data-testid="needs-announcement"
      >
        {announcement}
      </div>
      <div
        aria-live="polite"
        aria-atomic="true"
        className={styles.srOnly}
        data-testid="gate-announcement"
      >
        {newGateTitle ? t('app.newGate', { title: newGateTitle }) : ''}
      </div>
    </div>
  );
}
