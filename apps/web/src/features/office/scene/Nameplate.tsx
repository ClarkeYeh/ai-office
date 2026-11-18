import { memo } from 'react';
import type { Nameplate as NameplateVM } from '../model/index.js';
import css from './scene.module.css';

/**
 * DOM nameplate (never baked into the art). `x`/`y` are the plate's anchor in
 * world pixels relative to `origin` (the containing element's world position).
 */
export const Nameplate = memo(function Nameplate({
  plate,
  scale: s,
  origin,
  flash,
  compact = false,
}: {
  plate: NameplateVM;
  scale: number;
  origin: { x: number; y: number };
  flash: boolean;
  /** Title only (meeting chairs sit close together); the status stays in the aria label. */
  compact?: boolean;
}) {
  return (
    <span
      className={css.plate}
      data-tone={plate.tone}
      data-flash={flash ? 'true' : undefined}
      data-compact={compact ? 'true' : undefined}
      aria-hidden="true"
      style={{ left: (plate.x - origin.x) * s, top: (plate.y - origin.y) * s }}
    >
      <span className={css.plateTitle}>
        {plate.badge ? (
          <span className={css.badge} data-badge={plate.badge}>
            {plate.badge}
          </span>
        ) : null}
        {plate.title}
      </span>
      {plate.subtitle && !compact ? (
        <span className={css.plateSubtitle}>{plate.subtitle}</span>
      ) : null}
    </span>
  );
});
