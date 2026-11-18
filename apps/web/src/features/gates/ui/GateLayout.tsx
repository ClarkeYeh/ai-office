import { useSyncExternalStore, type ReactNode } from 'react';
import { t } from '../../../shared/lib/i18n/index.js';
import {
  Banner,
  Link,
  PixelFrame,
  PixelIcon,
} from '../../../shared/ui/index.js';
import type { GateHeaderViewModel } from '../model/index.js';
import styles from './gates.module.css';

const mobileQuery = '(max-width: 899px)';
function subscribeMobile(listener: () => void) {
  const query = globalThis.matchMedia(mobileQuery);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
/** D8: below 900px the office (and its thumbnail) is never mounted. */
export function useMobileLayout(): boolean {
  return useSyncExternalStore(
    subscribeMobile,
    () => globalThis.matchMedia(mobileQuery).matches,
    () => true,
  );
}

export interface GateLayoutProps {
  header: GateHeaderViewModel;
  backHref: string;
  /** Quiet office thumbnail (`OfficeScene` 1×, non-interactive). */
  thumbnail?: ReactNode;
  /** Outcome or error of the last action; rendered above the content. */
  notice?: ReactNode;
  /** Gate content (conclusion, work items, PR, options). */
  children: ReactNode;
  /** Decision controls: one primary, then secondary, then danger (red outline). */
  decision?: ReactNode;
  /** Replay (T14) or another read-only state: every decision control is disabled. */
  readOnly?: boolean;
}

/**
 * Full-page gate shell (D6, M4_DESIGN §4.3): waiting status and facts on top,
 * gate content in the middle, the decision column on the right.
 */
export function GateLayout({
  header,
  backHref,
  thumbnail,
  notice,
  children,
  decision,
  readOnly = false,
}: GateLayoutProps) {
  const mobile = useMobileLayout();
  return (
    <article
      className={styles.page}
      data-testid={`gate-page-${header.gateId}`}
      aria-labelledby="gate-heading"
    >
      <section className={styles.top}>
        {!mobile && (
          <div
            className={styles.thumbnail}
            data-testid="gate-thumbnail"
            role="img"
            aria-label={t('gates.thumbnail')}
          >
            {thumbnail ?? (
              <span className={styles.thumbnailDesk} aria-hidden="true">
                <PixelIcon name="attention" />
              </span>
            )}
          </div>
        )}
        <div className={styles.status}>
          <h2 id="gate-heading" className={styles.heading}>
            {header.heading}
          </h2>
          {header.quiet && (
            <p
              className={header.quiet.clear ? styles.quiet : styles.alive}
              data-testid="gate-quiet"
              data-clear={header.quiet.clear}
            >
              {header.quiet.text}
            </p>
          )}
          {header.decidedNote && (
            <p data-testid="gate-decided-note">{header.decidedNote}</p>
          )}
          <dl className={styles.facts} aria-label={t('gates.facts')}>
            {header.facts.map((fact) => (
              <div key={fact.id} data-testid={`gate-fact-${fact.id}`}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
          {mobile && <p className={styles.muted}>{t('gates.mobile')}</p>}
          <Link
            href={backHref}
            aria-label={t('gates.back')}
            data-testid="gate-back"
          >
            {t('gates.back')}
          </Link>
        </div>
      </section>
      <div className={styles.body}>
        <div className={styles.content}>
          {notice}
          {children}
        </div>
        <aside className={styles.decision} aria-label={t('gates.decision')}>
          {header.open && (
            <PixelFrame attention data-testid="gate-needs">
              <h3 className={styles.needsTitle}>
                <PixelIcon name="attention" />
                {t('gates.needs', { title: header.title })}
              </h3>
              {header.stageOrdinal && (
                <p className={styles.small}>{header.stageOrdinal}</p>
              )}
            </PixelFrame>
          )}
          {decision && (
            <PixelFrame data-testid="gate-actions">
              {readOnly && (
                <p className={styles.small} data-testid="gate-read-only">
                  {t('gates.replayReadOnly')}
                </p>
              )}
              {/* A disabled fieldset disables every control a gate body supplies. */}
              <fieldset className={styles.actions} disabled={readOnly}>
                {decision}
              </fieldset>
            </PixelFrame>
          )}
        </aside>
      </div>
    </article>
  );
}

/** Status line under the decision column after an action (aria-live). */
export function GateNotice({
  tone,
  children,
}: {
  tone: 'info' | 'error';
  children: ReactNode;
}) {
  return (
    <Banner tone={tone} data-testid="gate-notice" aria-live="polite">
      {children}
    </Banner>
  );
}

export function GateStatusMessage({ message }: { message: string }) {
  return (
    <PixelFrame>
      <p role="status" data-testid="gate-status">
        {message}
      </p>
    </PixelFrame>
  );
}
