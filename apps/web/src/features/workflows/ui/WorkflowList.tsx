import type { WorkflowRow } from '../model/workflows.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { Banner, Button, Link, PixelFrame } from '../../../shared/ui/index.js';
import styles from './workflows.module.css';

export function WorkflowList({
  rows,
  pending,
  confirmation,
  message,
  onRequest,
  onConfirm,
  onDismiss,
}: {
  rows: WorkflowRow[];
  pending: boolean;
  confirmation: { id: string; action: 'cancel' | 'cleanup' } | null;
  message: 'accepted' | 'failed' | null;
  onRequest: (id: string, action: 'cancel' | 'cleanup') => void;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className={styles.page}>
      <div className={styles.row}>
        <Link
          href="/workflows/new"
          data-testid="new-workflow"
          aria-label={t('workflows.start')}
        >
          {t('workflows.start')}
        </Link>
      </div>
      <p className={styles.intro}>{t('workflows.intro')}</p>
      {message && (
        <Banner tone={message === 'failed' ? 'error' : 'info'}>
          {t(`workflows.${message}`)}
        </Banner>
      )}
      {confirmation && (
        <PixelFrame
          role="group"
          aria-label={t(
            confirmation.action === 'cancel'
              ? 'workflows.confirmCancel'
              : 'workflows.confirmCleanup',
          )}
        >
          <p>
            {t(
              confirmation.action === 'cancel'
                ? 'workflows.confirmCancel'
                : 'workflows.confirmCleanup',
            )}
          </p>
          <p>{rows.find((row) => row.id === confirmation.id)?.requirement}</p>
          <div className={styles.row}>
            <Button
              variant="danger"
              data-testid="workflow-confirm"
              aria-label={t('workflows.confirm')}
              disabled={pending}
              onClick={onConfirm}
            >
              {t('workflows.confirm')}
            </Button>
            <Button
              data-testid="workflow-dismiss"
              aria-label={t('workflows.back')}
              disabled={pending}
              onClick={onDismiss}
            >
              {t('workflows.back')}
            </Button>
          </div>
        </PixelFrame>
      )}
      {!rows.length && (
        <PixelFrame>
          <p>{t('app.noWorkflows')}</p>
        </PixelFrame>
      )}
      <ul className={styles.list}>
        {rows.map((row) => (
          <li key={row.id}>
            <PixelFrame className={styles.item}>
              <h2>{row.requirement}</h2>
              <div className={styles.intro}>{row.context}</div>
              <div className={styles.row}>
                <strong>{row.status}</strong>
                {row.paused && <span>{t('workflows.paused')}</span>}
                <span>{row.stage}</span>
                <span>{row.progress}</span>
              </div>
              <div>{row.usage}</div>
              <div className={styles.row}>
                <Link
                  href={`/workflows/${encodeURIComponent(row.id)}`}
                  data-testid={`workflow-${row.id}`}
                  aria-label={`${t('workflows.open')} ${row.requirement}`}
                >
                  {t('workflows.open')}
                </Link>
                {row.canCancel && (
                  <Button
                    data-testid={`workflow-cancel-${row.id}`}
                    aria-label={t('workflows.cancel')}
                    disabled={pending}
                    onClick={() => onRequest(row.id, 'cancel')}
                  >
                    {t('workflows.cancel')}
                  </Button>
                )}
                {row.canCleanup && (
                  <Button
                    data-testid={`workflow-cleanup-${row.id}`}
                    aria-label={t('workflows.cleanup')}
                    disabled={pending}
                    onClick={() => onRequest(row.id, 'cleanup')}
                  >
                    {t('workflows.cleanup')}
                  </Button>
                )}
              </div>
            </PixelFrame>
          </li>
        ))}
      </ul>
    </div>
  );
}
