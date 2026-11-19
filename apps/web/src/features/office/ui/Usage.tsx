import { t } from '../../../shared/lib/i18n/index.js';
import { sheetsFor } from '../model/index.js';
import { PixelFrame } from '../../../shared/ui/index.js';
import css from './office.module.css';
export function OfficeUsage({
  totalTokens,
  budgetDisabled = false,
}: {
  totalTokens: number;
  budgetDisabled?: boolean;
}) {
  return (
    <PixelFrame data-testid="token-usage">
      <h2>{t('app.usage')}</h2>
      <div className={css.usage}>
        <span
          className={css.paperStack}
          aria-hidden="true"
          data-testid="usage-paper-stack"
        >
          {Array.from({ length: sheetsFor(totalTokens) }, (_, i) => (
            <i key={i} style={{ bottom: i * 4 }} />
          ))}
        </span>
        <strong>{totalTokens.toLocaleString('zh-TW')}</strong>
      </div>
      <p>{t('office.page.usageOnly')}</p>
      {budgetDisabled && <p>{t('office.usage.budgetDisabled')}</p>}
    </PixelFrame>
  );
}
