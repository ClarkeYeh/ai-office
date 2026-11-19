import { Component, type ReactNode } from 'react';
import { t } from '../shared/lib/i18n/index.js';
import { Button, PixelFrame } from '../shared/ui/index.js';
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main>
        <PixelFrame role="alert">
          <h1>{t('app.error')}</h1>
          <Button
            aria-label={t('app.reload')}
            data-testid="error-reload"
            onClick={() => globalThis.location.reload()}
          >
            {t('app.reload')}
          </Button>
        </PixelFrame>
      </main>
    );
  }
}
