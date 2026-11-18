import type { ReactNode } from 'react';
import { useWebState } from '../realtime/index.js';
import { t } from '../shared/lib/i18n/index.js';
import { Button, PixelFrame } from '../shared/ui/index.js';
import styles from './shell.module.css';
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useWebState((state) => state.auth);
  const status = useWebState((state) => state.connection.status);
  if (auth === 'missing')
    return (
      <main className={styles.standalone} data-testid="auth-required">
        <PixelFrame>
          <h1>{t('auth.title')}</h1>
          <p>{t('auth.description')}</p>
          <pre>{t('auth.command')}</pre>
        </PixelFrame>
      </main>
    );
  if (auth === 'unknown')
    return (
      <main className={styles.standalone} aria-busy={status !== 'offline'}>
        <h1>{t('app.name')}</h1>
        <p role="status">
          {t(status === 'offline' ? 'app.loadFailed' : 'app.loading')}
        </p>
        {status === 'offline' && (
          <Button
            aria-label={t('app.retry')}
            data-testid="auth-retry"
            onClick={() => globalThis.location.reload()}
          >
            {t('app.retry')}
          </Button>
        )}
      </main>
    );
  return children;
}
