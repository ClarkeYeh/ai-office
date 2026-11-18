import { useId, useRef, useState, type ReactNode } from 'react';
import { Button, PixelFrame } from '../../../shared/ui/index.js';
import { seatsT as t } from '../../../shared/lib/i18n/seats.js';
import type { SeatInspectorVM } from '../model/seatInspector.js';
import css from './seats.module.css';

export type SendResult = { ok: true } | { ok: false; message: string };
export function SeatInspectorPanel({
  vm,
  renderPortrait,
  onSend,
  historyState,
  onRetryHistory,
}: {
  vm: SeatInspectorVM;
  renderPortrait: () => ReactNode;
  onSend: (body: string) => Promise<SendResult>;
  historyState: 'loading' | 'ready' | 'error';
  onRetryHistory: () => void;
}) {
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const submitting = useRef(false);
  const id = useId();
  const valid =
    body.trim().length > 0 &&
    (body.split(/\r\n|\n|\r/, 1)[0]?.trim().length ?? 0) > 0;
  async function submit() {
    if (submitting.current || vm.disabledReason || !valid) return;
    submitting.current = true;
    setPending(true);
    setResult(null);
    try {
      const next = await onSend(body);
      setResult(next);
      if (next.ok) setBody('');
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  return (
    <PixelFrame
      className={css.panel}
      data-testid="seat-inspector"
      aria-label={t('seats.title')}
    >
      <header className={css.header}>
        {renderPortrait()}
        <div>
          <h2>{vm.role}</h2>
          <p>
            <span className={css.badge} data-vendor={vm.agent}>
              {vm.badge}
            </span>{' '}
            {vm.vendor}
          </p>
          {vm.ondemand && <p data-testid="seat-ondemand">{vm.ondemand}</p>}
        </div>
      </header>
      <p className={css.state} data-testid="seat-state">
        {vm.state}
      </p>
      {vm.degraded && <p>{t('office.seat.degraded')}</p>}
      <dl className={css.facts}>
        <div>
          <dt>{t('seats.doing')}</dt>
          <dd data-testid="seat-doing">{vm.doing}</dd>
        </div>
        <div>
          <dt>{t('seats.attemptLabel')}</dt>
          <dd>{vm.attempt}</dd>
        </div>
        <div>
          <dt>{t('seats.reworks')}</dt>
          <dd data-testid="seat-reworks">{vm.reworks}</dd>
        </div>
        <div>
          <dt>{t('seats.usage')}</dt>
          <dd data-testid="seat-tokens">{vm.tokens}</dd>
        </div>
      </dl>
      <section aria-label={t('seats.activity')} data-testid="seat-activity">
        <h3>{t('seats.activity')}</h3>
        {vm.activity.length ? (
          <ul className={css.activity}>
            {vm.activity.map((a) => (
              <li key={a.id}>
                <span
                  className={css.swatch}
                  data-category={a.category}
                  aria-hidden="true"
                />
                <span>
                  {t('seats.activityCount', { tool: a.label, n: a.count })}
                </span>
                <time dateTime={a.at} title={a.at}>
                  {a.age}
                </time>
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('seats.empty')}</p>
        )}
      </section>
      <section aria-label={t('seats.reviews')} data-testid="seat-reviews">
        <h3>{t('seats.reviews')}</h3>
        <p>{t('seats.reviewCount', { n: vm.reviewCount })}</p>
        {historyState === 'loading' && (
          <p role="status">{t('seats.historyLoading')}</p>
        )}
        {historyState === 'error' && (
          <>
            <p role="alert">{t('seats.historyFailed')}</p>
            <Button
              data-testid="seat-history-retry"
              aria-label={t('app.retry')}
              onClick={onRetryHistory}
            >
              {t('app.retry')}
            </Button>
          </>
        )}
        {vm.reviews.length ? (
          <ol className={css.records}>
            {vm.reviews.map((r) => (
              <li key={r.id}>
                <strong>{r.title}</strong>
                <ul>
                  {r.reasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        ) : (
          historyState === 'ready' && <p>{t('seats.empty')}</p>
        )}
      </section>
      {vm.statements.length > 0 && (
        <section aria-label={t('seats.meeting')} data-testid="seat-meeting">
          <h3>{t('seats.meeting')}</h3>
          {vm.statements.map((s) => (
            <div key={s.id}>
              <strong>{s.round}</strong>
              <p>{s.position}</p>
              <h4>{t('seats.arguments')}</h4>
              <ul>
                {s.arguments.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
              <h4>{t('seats.concerns')}</h4>
              <ul>
                {s.concerns.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
      {vm.errors.length > 0 && (
        <section aria-label={t('seats.errors')} data-testid="seat-errors">
          <h3>{t('seats.errors')}</h3>
          <ul className={css.records}>
            {vm.errors.map((e) => (
              <li key={e.id}>
                <code>{e.code}</code>
                <p>{e.message}</p>
                <time dateTime={e.at}>{e.at}</time>
              </li>
            ))}
          </ul>
        </section>
      )}
      <details data-testid="seat-attempt-history">
        <summary
          data-testid="seat-attempt-toggle"
          aria-label={t('seats.history')}
        >
          {t('seats.history')}
        </summary>
        <ul className={css.records}>
          {vm.attempts.map((a) => (
            <li key={a.id}>
              {a.label}
              <br />
              <time dateTime={a.at}>{a.at}</time>
              <p>
                {t('seats.usage')}: {a.tokens}
              </p>
            </li>
          ))}
        </ul>
      </details>
      <form
        aria-label={t('seats.message')}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={id}>{t('seats.messageTo', { role: vm.role })}</label>
        <textarea
          id={id}
          data-testid="seat-message-body"
          aria-label={t('seats.messageTo', { role: vm.role })}
          aria-describedby={`${id}-hint ${id}-disabled`}
          value={body}
          disabled={pending || vm.disabledReason !== null}
          onChange={(e) => {
            setBody(e.target.value);
            setResult(null);
          }}
          rows={3}
        />
        <p id={`${id}-hint`} className={css.hint}>
          {t('seats.subjectAuto')}
        </p>
        <p
          id={`${id}-disabled`}
          data-testid="seat-message-disabled"
          className={css.hint}
        >
          {vm.disabledReason}
        </p>
        {result && (
          <p
            role={result.ok ? 'status' : 'alert'}
            data-testid="seat-message-result"
          >
            {result.ok ? t('seats.sent') : result.message}
          </p>
        )}
        <div className={css.actions}>
          <Button
            type="submit"
            variant="primary"
            data-testid="seat-message-send"
            aria-label={t('seats.send')}
            disabled={pending || vm.disabledReason !== null || !valid}
          >
            {t(pending ? 'seats.sending' : 'seats.send')}
          </Button>
        </div>
      </form>
    </PixelFrame>
  );
}
