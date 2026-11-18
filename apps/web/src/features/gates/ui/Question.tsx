import { useState } from 'react';
import type { QuestionView } from '@ai-office/contracts/api';
import { t } from '../../../shared/lib/i18n/index.js';
import { Button, Link, PixelFrame } from '../../../shared/ui/index.js';
import styles from './forms.module.css';
export function Question({
  question,
  disabled,
  onAnswer,
}: {
  question: QuestionView;
  disabled: boolean;
  onAnswer: (body: string, optionId?: string) => void;
}) {
  const [body, setBody] = useState('');
  const [option, setOption] = useState('');
  return (
    <PixelFrame>
      <section className={styles.stack}>
        <h2>{t('gates.question.title')}</h2>
        <p>
          {question.role}
          {question.itemKey ? ` · ${question.itemKey}` : ''}
        </p>
        <p className={styles.prose}>{question.body}</p>
        <label className={styles.field}>
          {t('gates.question.option')}
          <select
            aria-label={t('gates.question.option')}
            data-testid="question-option"
            disabled={disabled}
            value={option}
            onChange={(e) => setOption(e.target.value)}
          >
            <option value="">{t('gates.question.none')}</option>
            {question.escalation?.options.map((o) => (
              <option key={o.optionId} value={o.optionId}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          {t('gates.question.answer')}
          <textarea
            aria-label={t('gates.question.answer')}
            data-testid="question-answer"
            disabled={disabled}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <Button
          aria-label={t('gates.question.submit')}
          variant="primary"
          data-testid="question-submit"
          disabled={disabled || !body.trim()}
          onClick={() => onAnswer(body.trim(), option || undefined)}
        >
          {t('gates.question.submit')}
        </Button>
        <Link
          href={`/workflows/${encodeURIComponent(question.workflowId)}`}
          aria-label={t('gates.back')}
          data-testid="question-back"
        >
          {t('gates.back')}
        </Link>
      </section>
    </PixelFrame>
  );
}
