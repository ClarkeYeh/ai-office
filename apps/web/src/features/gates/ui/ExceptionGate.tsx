import { useState } from 'react';
import { hasMessage, t } from '../../../shared/lib/i18n/index.js';
import { Button } from '../../../shared/ui/index.js';
import { optionAction, type GateAction } from '../model/actions.js';
import type { GateView } from '../model/index.js';
import styles from './forms.module.css';

export function ExceptionGate({
  gate,
  disabled,
  onDecision,
}: {
  gate: GateView;
  disabled: boolean;
  onDecision: (body: GateAction) => void;
}) {
  const [selected, setSelected] = useState('');
  const [value, setValue] = useState('');
  const option = gate.options.find((o) => o.optionId === selected);
  const action = option ? optionAction(option, value) : null;
  const key =
    gate.exceptionKind === ('spawn-stall' as string)
      ? 'gates.exception.spawn-stall'
      : `exception.${gate.exceptionKind}`;
  const label = option?.input ? t(`gates.exception.${option.input}`) : '';
  return (
    <section className={styles.stack}>
      <h3>{hasMessage(key) ? t(key) : gate.title}</h3>
      {gate.content.type === 'exception' && (
        <>
          <p className={styles.prose}>{gate.content.summary}</p>
          {gate.content.decisionRequest && (
            <p>{gate.content.decisionRequest.question}</p>
          )}
          {gate.content.changedFiles && (
            <ul>
              {gate.content.changedFiles.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          )}
        </>
      )}
      <fieldset disabled={disabled} className={styles.stack}>
        <legend>{t('gates.exception.choose')}</legend>
        {gate.options.map((o) => (
          <label key={o.optionId}>
            <input
              type="radio"
              name="exception-option"
              aria-label={o.label}
              data-testid={`option-${o.optionId}`}
              checked={selected === o.optionId}
              onChange={() => {
                setSelected(o.optionId);
                setValue('');
              }}
            />
            {o.label}
          </label>
        ))}
        {option?.input && (
          <label className={styles.field}>
            {label}
            {option.input === 'agent' ? (
              <select
                aria-label={label}
                data-testid="option-input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              >
                <option value="">{t('gates.exception.choose')}</option>
                <option value="claude-code">
                  {t('office.vendor.claude-code')}
                </option>
                <option value="codex">{t('office.vendor.codex')}</option>
              </select>
            ) : (
              <input
                aria-label={label}
                data-testid="option-input"
                type={option.input === 'tokens' ? 'number' : 'text'}
                min={option.input === 'tokens' ? 1 : undefined}
                step={option.input === 'tokens' ? 1 : undefined}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </label>
        )}
      </fieldset>
      <Button
        aria-label={t('gates.exception.submit')}
        data-testid="option-submit"
        disabled={disabled || !action}
        onClick={() => {
          if (action) onDecision(action);
        }}
      >
        {t('gates.exception.submit')}
      </Button>
    </section>
  );
}
