import { useDisplayedModel, useWebState } from '../../../realtime/index.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { Banner, Link } from '../../../shared/ui/index.js';
import { isRateLimited } from '../model/actions.js';
/** Navigation remains available in replay; the destination disables decisions. */
export function GateBannerActions() {
  const model = useDisplayedModel();
  const overview = useWebState((state) => state.overview.gates);
  const replaying = useWebState((state) => state.replay !== null);
  const gates = model?.gates ?? (replaying ? [] : overview);
  const rateLimited =
    model?.seats.flatMap((seat) => seat.attempts).filter(isRateLimited) ?? [];
  return (
    <>
      {gates
        .filter((gate) => gate.kind === 'exception' && gate.status === 'open')
        .map((gate) => (
          <Banner key={gate.gateId} data-testid={`gate-banner-${gate.gateId}`}>
            <Link
              href={`/gates/${encodeURIComponent(gate.gateId)}`}
              aria-label={t('gates.banner.open', { title: gate.title })}
              data-testid={`gate-banner-link-${gate.gateId}`}
            >
              {t('gates.banner.open', { title: gate.title })}
            </Link>
          </Banner>
        ))}
      {rateLimited.map((attempt) => (
        <Banner
          key={attempt.attemptId}
          data-testid={`quota-${attempt.attemptId}`}
        >
          {attempt.role}: {t('gates.rateLimited')}
        </Banner>
      ))}
    </>
  );
}
