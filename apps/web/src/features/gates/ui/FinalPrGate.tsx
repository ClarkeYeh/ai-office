import { useState } from 'react';
import { t } from '../../../shared/lib/i18n/index.js';
import { Button, Link } from '../../../shared/ui/index.js';
import type { GateAction } from '../model/actions.js';
import type { GateView } from '../model/index.js';
import styles from './forms.module.css';
export function FinalPrGate({
  gate,
  url,
  remaining,
  disabled,
  onDecision,
}: {
  gate: GateView;
  url?: string | undefined;
  remaining: number | null;
  disabled: boolean;
  onDecision: (body: GateAction) => void;
}) {
  const [feedback, setFeedback] = useState('');
  const pr = gate.pr;
  const number =
    pr?.number ??
    (gate.content.type === 'final-pr' ? gate.content.pr : undefined);
  return (
    <section className={styles.stack}>
      <p>
        {t(
          pr?.state === 'merged' || gate.closeReason === 'merged'
            ? 'gates.final.merged'
            : 'gates.final.wait',
        )}
      </p>
      {number && url ? (
        <Link
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label={t('gates.final.open', { number })}
          data-testid="final-pr-link"
        >
          {t('gates.final.open', { number })}
        </Link>
      ) : (
        <p>{t('gates.final.unavailable')}</p>
      )}
      {pr && (
        <>
          <p>{t('gates.final.branches', { head: pr.head, base: pr.base })}</p>
          <p data-testid="final-pr-checks">
            {t('gates.final.checks', {
              status: t(`gates.final.${pr.checks ?? 'unknown'}`),
            })}
          </p>
        </>
      )}
      {remaining === 0 && <p>{t('gates.final.limit')}</p>}
      <label className={styles.field}>
        {t('gates.feedback')}
        <textarea
          aria-label={t('gates.feedback')}
          data-testid="final-feedback"
          disabled={disabled || remaining === 0}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
      </label>
      <Button
        variant="secondary"
        aria-label={t('gates.final.reject')}
        data-testid="final-reject"
        disabled={disabled || remaining === 0 || !feedback.trim()}
        onClick={() =>
          onDecision({ decision: 'reject', comment: feedback.trim() })
        }
      >
        {t('gates.final.reject')}
      </Button>
      {gate.options
        .filter((o) => o.optionId === 'keep-open' || o.optionId === 'abort')
        .map((o) => (
          <Button
            key={o.optionId}
            variant={o.optionId === 'abort' ? 'danger' : 'secondary'}
            aria-label={t(
              o.optionId === 'abort' ? 'gates.final.abort' : 'gates.final.keep',
            )}
            data-testid={`final-${o.optionId}`}
            disabled={disabled}
            onClick={() =>
              onDecision({ decision: 'option', optionId: o.optionId })
            }
          >
            {t(
              o.optionId === 'abort' ? 'gates.final.abort' : 'gates.final.keep',
            )}
          </Button>
        ))}
    </section>
  );
}
