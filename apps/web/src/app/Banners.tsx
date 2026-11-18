import { GateBannerActions } from '../features/gates/index.js';
import type { HealthView } from '@ai-office/contracts/api';
import { hasMessage, t } from '../shared/lib/i18n/index.js';
import { Banner } from '../shared/ui/index.js';
export interface BannersProps {
  pausedReasons?: readonly string[];
  health?: HealthView | null;
  degraded?: boolean;
  replaying?: boolean;
  syncing?: boolean;
  connection?: string;
  gateActions?: boolean;
}
export function Banners({
  pausedReasons = [],
  health,
  degraded,
  replaying,
  syncing,
  connection,
  gateActions,
}: BannersProps) {
  return (
    <div data-testid="banners">
      {gateActions && <GateBannerActions />}
      {pausedReasons.map((reason) => {
        const key = `pause.${reason}`;
        return (
          <Banner key={reason} tone="error" data-testid={`pause-${reason}`}>
            {t('banner.paused', {
              reason: hasMessage(key) ? t(key) : t('banner.unknownPause'),
            })}
          </Banner>
        );
      })}
      {health?.runtime.runOwned === false && (
        <Banner tone="error" data-testid="banner-hijacked">
          {t('banner.hijacked')}
        </Banner>
      )}
      {health &&
        (['runtime', 'scm', 'store', 'usage'] as const).map(
          (component) =>
            health[component].status !== 'healthy' && (
              <Banner
                tone="error"
                key={component}
                data-testid={`health-${component}`}
              >
                {t('banner.health', { component: t(`health.${component}`) })}
              </Banner>
            ),
        )}
      {health && !health.runtime.verified && (
        <Banner data-testid="banner-unverified">
          {t('banner.unverified')}
        </Banner>
      )}
      {health?.runtime.mode === 'fake' && (
        <Banner data-testid="banner-fake">{t('banner.fake')}</Banner>
      )}
      {degraded && (
        <Banner data-testid="banner-degraded">{t('banner.degraded')}</Banner>
      )}
      {replaying && (
        <Banner data-testid="banner-replay">{t('banner.replay')}</Banner>
      )}
      {syncing && (
        <Banner data-testid="banner-syncing">{t('app.syncing')}</Banner>
      )}
      {connection && connection !== 'live' && (
        <Banner data-testid="banner-connection">
          {t(connection === 'connecting' ? 'app.connecting' : 'app.offline')}
        </Banner>
      )}
    </div>
  );
}
