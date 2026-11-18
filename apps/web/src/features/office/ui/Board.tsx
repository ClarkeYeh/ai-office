import { memo } from 'react';
import type { BoardViewModel } from '../model/index.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { Link } from '../../../shared/ui/index.js';
import css from './office.module.css';

export const Board = memo(function Board({
  vm,
  onSelectSeat,
}: {
  vm: BoardViewModel;
  onSelectSeat: (id: string) => void;
}) {
  return (
    <section data-testid="office-board" aria-label={t('app.board')}>
      <div className={css.columns}>
        {vm.columns.map((column) => (
          <section key={column.id} data-testid={column.testId}>
            <h2>
              {column.label} <small>{column.cards.length}</small>
            </h2>
            {column.cards.map((card) => (
              <article
                key={card.itemKey}
                data-testid={card.testId}
                data-tone={card.tone}
                className={css.card}
              >
                {card.seatId ? (
                  <button
                    type="button"
                    aria-label={card.ariaLabel}
                    data-testid={`${card.testId}-select`}
                    onClick={() => onSelectSeat(card.seatId!)}
                  >
                    {card.itemKey}
                  </button>
                ) : (
                  <strong>{card.itemKey}</strong>
                )}
                <p>{card.title}</p>
                <small>{card.statusLabel}</small>
                {card.note && <p>{card.note}</p>}
                {card.pr &&
                  (card.pr.url ? (
                    <Link
                      href={card.pr.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={t('office.inbox.pr', { n: card.pr.number })}
                      data-testid={`${card.testId}-pr`}
                    >
                      {t('office.inbox.pr', { n: card.pr.number })}
                    </Link>
                  ) : (
                    <p>{t('office.inbox.pr', { n: card.pr.number })}</p>
                  ))}
              </article>
            ))}
          </section>
        ))}
      </div>
      <h2>{t('office.page.lanes')}</h2>
      <div className={css.lanes}>
        {vm.lanes.map((lane) => (
          <div className={css.lane} key={lane.seatId} data-testid={lane.testId}>
            <button
              type="button"
              data-testid={`${lane.testId}-select`}
              aria-label={lane.ariaLabel}
              aria-pressed={lane.selected}
              onClick={() => onSelectSeat(lane.seatId)}
            >
              {lane.badge} {lane.title}
            </button>
            <div className={css.track}>
              {lane.segments.map((segment) => (
                <span
                  key={segment.attemptId}
                  data-testid={segment.testId}
                  data-pose={segment.pose}
                  className={css.segment}
                  role="img"
                  aria-label={segment.ariaLabel}
                  title={segment.ariaLabel}
                  style={{
                    left: `${(100 * segment.start) / Math.max(1, vm.span)}%`,
                    width: `${Math.max(0.5, (100 * (segment.end - segment.start)) / Math.max(1, vm.span))}%`,
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
});
