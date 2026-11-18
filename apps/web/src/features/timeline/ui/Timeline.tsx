import type { KeyboardEvent } from 'react';
import type { TimelineModel, TimelinePoint } from '../model/timeline.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { Banner, Button, PixelFrame } from '../../../shared/ui/index.js';
import styles from './timeline.module.css';

export interface TimelineProps {
  model: TimelineModel;
  index: number;
  messages: readonly TimelinePoint[];
  replaying: boolean;
  loading: boolean;
  progress: number;
  failed: boolean;
  pending: boolean;
  onOpen(): void;
  onExit(): void;
  onSeek(index: number): void;
  onStep(): void;
}

export function Timeline({
  model,
  index,
  messages,
  replaying,
  loading,
  progress,
  failed,
  pending,
  onOpen,
  onExit,
  onSeek,
  onStep,
}: TimelineProps) {
  const count = model.points.length;
  const point = model.points[index];
  const disabled = loading || !count;
  const position = t('timeline.position', {
    index: count ? index + 1 : 0,
    count,
    seq: point?.seq ?? 0,
  });
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const key = event.key;
    if (
      ![
        'ArrowLeft',
        'ArrowDown',
        'ArrowRight',
        'ArrowUp',
        'Home',
        'End',
      ].includes(key)
    )
      return;
    event.preventDefault();
    if (key === 'ArrowRight' || key === 'ArrowUp') onStep();
    else
      onSeek(
        key === 'Home' ? 0 : key === 'End' ? count - 1 : Math.max(0, index - 1),
      );
  }
  return (
    <PixelFrame className={styles.timeline} data-testid="timeline">
      <header className={styles.header}>
        <div>
          <h1>{t('timeline.title')}</h1>
          <p>{t('timeline.description')}</p>
        </div>
        <Button
          variant="primary"
          aria-label={t(replaying ? 'timeline.live' : 'timeline.open')}
          data-testid={replaying ? 'timeline-live' : 'timeline-open'}
          onClick={replaying ? onExit : onOpen}
        >
          {t(replaying ? 'timeline.live' : 'timeline.open')}
        </Button>
      </header>
      {failed && (
        <Banner tone="error" data-testid="timeline-error">
          {t('app.loadFailed')}{' '}
          <Button
            aria-label={t('app.retry')}
            data-testid="timeline-retry"
            onClick={onOpen}
          >
            {t('app.retry')}
          </Button>
        </Banner>
      )}
      {!replaying && <p role="status">{t('timeline.liveStatus')}</p>}
      {replaying && (
        <>
          <Banner data-testid="timeline-readonly">
            {t('timeline.readOnly')}
          </Banner>
          {loading && (
            <div role="status" aria-busy="true">
              <label>
                {t('timeline.loading', { percent: Math.round(progress * 100) })}
                <progress max={1} value={progress} />
              </label>
            </div>
          )}
          {!loading && !count && <p>{t('timeline.empty')}</p>}
          <div className={styles.segments} aria-label={t('timeline.segments')}>
            {model.segments.map((segment) => (
              <button
                key={segment.seq}
                type="button"
                disabled={disabled}
                className={styles.segment}
                style={{ flexGrow: segment.endIndex - segment.index + 1 }}
                aria-label={t('timeline.seek', {
                  label: segment.label,
                  seq: segment.seq,
                })}
                data-testid={`timeline-segment-${segment.seq}`}
                onClick={() => onSeek(segment.index)}
              >
                {segment.label}
              </button>
            ))}
          </div>
          <div className={styles.markerRail} aria-hidden="true">
            {model.markers.map((marker) => (
              <span
                key={marker.seq}
                style={{
                  left:
                    String((marker.index / Math.max(1, count - 1)) * 100) + '%',
                }}
              >
                {marker.kind === 'gate' ? '⚑' : '◇'}
              </span>
            ))}
          </div>
          <label className={styles.position} htmlFor="timeline-scrubber">
            {position}
          </label>
          <input
            id="timeline-scrubber"
            className={styles.scrubber}
            type="range"
            min={0}
            max={Math.max(0, count - 1)}
            step={1}
            value={index}
            disabled={disabled}
            aria-label={t('timeline.scrubber')}
            aria-valuetext={position}
            aria-describedby="timeline-keys"
            data-testid="timeline-scrubber"
            onChange={(event) => onSeek(Number(event.target.value))}
            onKeyDown={onKeyDown}
          />
          <div className={styles.controls}>
            <Button
              aria-label={t('timeline.first')}
              data-testid="timeline-first"
              disabled={disabled || index === 0}
              onClick={() => onSeek(0)}
            >
              {t('timeline.first')}
            </Button>
            <Button
              aria-label={t('timeline.previous')}
              data-testid="timeline-previous"
              disabled={disabled || index === 0}
              onClick={() => onSeek(index - 1)}
            >
              {t('timeline.previous')}
            </Button>
            <Button
              aria-label={t('timeline.next')}
              data-testid="timeline-next"
              disabled={disabled || pending || index >= count - 1}
              onClick={onStep}
            >
              {t('timeline.next')}
            </Button>
            <Button
              aria-label={t('timeline.last')}
              data-testid="timeline-last"
              disabled={disabled || index >= count - 1}
              onClick={() => onSeek(count - 1)}
            >
              {t('timeline.last')}
            </Button>
          </div>
          <p id="timeline-keys" className={styles.hint}>
            {t('timeline.keys')}
          </p>
          <section>
            <h2>{t('timeline.markers')}</h2>
            <div className={styles.markers}>
              {model.markers.map((marker) => (
                <Button
                  key={marker.seq}
                  className={styles.marker}
                  disabled={disabled}
                  aria-label={t('timeline.seek', {
                    label: marker.label,
                    seq: marker.seq,
                  })}
                  data-testid={`timeline-marker-${marker.seq}`}
                  onClick={() => onSeek(marker.index)}
                >
                  <span aria-hidden="true">
                    {marker.kind === 'gate' ? '⚑' : '◇'}
                  </span>{' '}
                  {marker.label}
                </Button>
              ))}
            </div>
            {!model.markers.length && (
              <p className={styles.hint}>{t('timeline.noMarkers')}</p>
            )}
          </section>
          <section>
            <h2>{t('timeline.messages')}</h2>
            <p className={styles.hint}>{t('timeline.recent', { count: 50 })}</p>
            <ol className={styles.messages}>
              {messages.map((message) => (
                <li key={message.seq}>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={t('timeline.seek', {
                      label: message.label,
                      seq: message.seq,
                    })}
                    data-testid={`timeline-message-${message.seq}`}
                    onClick={() => onSeek(message.index)}
                  >
                    <time dateTime={message.at}>
                      {message.at.replace('T', ' ').replace('.000Z', 'Z')}
                    </time>
                    <span>{message.label}</span>
                  </button>
                </li>
              ))}
            </ol>
            {!messages.length && <p>{t('timeline.noMessages')}</p>}
          </section>
        </>
      )}
    </PixelFrame>
  );
}
