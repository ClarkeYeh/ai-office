import { t } from '../../../shared/lib/i18n/index.js';
import css from './office.module.css';
const signals = [
  'claude-code',
  'codex',
  'edit',
  'shell',
  'read',
  'git',
  'network',
  'other',
  'need',
  'error',
] as const;
export function OfficeLegend() {
  return (
    <ul
      className={css.legend}
      aria-label={t('office.page.legend')}
      data-testid="office-legend"
    >
      {signals.map((signal) => (
        <li key={signal}>
          <i aria-hidden="true" data-signal={signal} />
          {t(`office.legend.${signal}`)}
        </li>
      ))}
    </ul>
  );
}
