import { memo } from 'react';
import type { OfficeSeat, OfficeViewModel } from '../model/index.js';
import { atlas, BACKGROUND_URLS, placements } from './atlas.js';
import { figureOf, shiftY, WINDOW_PANES, type Sky } from './geometry.js';
import { Sprite } from './Sprite.js';
import type { Suppressed } from './suppress.js';
import css from './scene.module.css';

// The static floor: stacked background strips, then the state sprites the
// background leaves room for (TV, door, lamp, monitors, chairs, paper, parcels).

const { topHeight, rowHeight, bottomHeight, width } = atlas.world;

/** §3.6: top, first desk row, extra rows × (rows − 1), bottom; as `<img>`. */
export const Background = memo(function Background({
  rows,
  scale: s,
}: {
  rows: number;
  scale: number;
}) {
  const strips: { src: string; y: number; h: number; key: string }[] = [
    { src: BACKGROUND_URLS.top, y: 0, h: topHeight, key: 'top' },
    { src: BACKGROUND_URLS.rowFirst, y: topHeight, h: rowHeight, key: 'row0' },
  ];
  for (let row = 1; row < rows; row++)
    strips.push({
      src: BACKGROUND_URLS.rowExtra,
      y: topHeight + rowHeight * row,
      h: rowHeight,
      key: `row${row}`,
    });
  strips.push({
    src: BACKGROUND_URLS.bottom,
    y: topHeight + rowHeight * rows,
    h: bottomHeight,
    key: 'bottom',
  });
  return (
    <>
      {strips.map((strip) => (
        <img
          key={strip.key}
          className={css.background}
          src={strip.src}
          alt=""
          draggable={false}
          width={width * s}
          height={strip.h * s}
          style={{ top: strip.y * s }}
        />
      ))}
    </>
  );
});

const SKY_COLORS: Record<Sky, string | null> = {
  day: null,
  evening: '#d77643',
  night: '#3a4466',
};

/** §3.4: the window glass tinted by the local time (day is the drawn sky). */
export const SkyPanes = memo(function SkyPanes({
  sky,
  scale: s,
}: {
  sky: Sky;
  scale: number;
}) {
  const color = SKY_COLORS[sky];
  return (
    <span data-testid="office-sky" data-sky={sky}>
      {color
        ? WINDOW_PANES.map((p) => (
            <span
              key={`${p.x}`}
              className={css.pane}
              style={{
                left: p.x * s,
                top: p.y * s,
                width: p.w * s,
                height: p.h * s,
                background: color,
              }}
            />
          ))
        : null}
    </span>
  );
});

const deskX = (desk: number) => placements.deskX[desk % 3]!;
const rowTop = (desk: number) => topHeight + rowHeight * Math.floor(desk / 3);

const MONITOR: Record<OfficeSeat['screen'], string> = {
  off: 'monitor.off',
  dark: 'monitor.off',
  error: 'monitor.error',
  read: 'monitor.read',
  edit: 'monitor.edit',
  shell: 'monitor.shell',
  git: 'monitor.git',
  network: 'monitor.network',
  other: 'monitor.other',
};

/** Monitors, chairs, mugs and notes on every desk of the work area. */
const Desks = memo(function Desks({
  vm,
  scale: s,
}: {
  vm: OfficeViewModel;
  scale: number;
}) {
  const bySeat = new Map<number, OfficeSeat>();
  for (const seat of vm.seats)
    if (seat.place === 'desk' && seat.desk !== undefined)
      bySeat.set(seat.desk, seat);
  const reserved = new Set(vm.reserved.map((r) => r.desk));
  const { monitor, chairTucked, chairPushed, mug, note } = placements.desk;
  const out = [];
  for (let desk = 0; desk < vm.world.rows * 3; desk++) {
    const x = deskX(desk);
    const y = rowTop(desk);
    const seat = bySeat.get(desk);
    const frame = seat ? figureOf(seat)?.frame : undefined;
    // `type` and `slump` frames include the chair.
    const chairInFigure = frame === 'type' || frame === 'slump';
    const pushed = seat !== undefined && !chairInFigure;
    out.push(
      <Sprite
        key={`m${desk}`}
        name={MONITOR[seat?.screen ?? 'off']}
        scale={s}
        x={x + monitor.x}
        y={y + monitor.y}
        testId={`desk-monitor-${desk}`}
      />,
    );
    if (seat?.degraded)
      out.push(
        <Sprite
          key={`n${desk}`}
          name="monitor-noise"
          scale={s}
          x={x + monitor.x + 2}
          y={y + monitor.y + 2}
        />,
      );
    if (!chairInFigure) {
      const at = pushed ? chairPushed : chairTucked;
      out.push(
        <Sprite
          key={`c${desk}`}
          name="chair.back"
          scale={s}
          x={x + at.x}
          y={y + at.y}
        />,
      );
    }
    if (seat?.pose === 'idle')
      out.push(
        <Sprite
          key={`u${desk}`}
          name="mug"
          scale={s}
          x={x + mug.x}
          y={y + mug.y}
        />,
      );
    if (reserved.has(desk))
      out.push(
        <Sprite
          key={`r${desk}`}
          name="paper.note"
          scale={s}
          x={x + note.x}
          y={y + note.y}
        />,
      );
  }
  return <>{out}</>;
});

/** Everything state-dependent that is not a button. */
export const FloorProps = memo(function FloorProps({
  vm,
  scale: s,
  hidden,
}: {
  vm: OfficeViewModel;
  scale: number;
  hidden: Suppressed;
}) {
  const rows = vm.world.rows;
  return (
    <>
      <Sprite
        name={vm.stageKind === 'meeting' ? 'tv.meeting' : 'tv.off'}
        scale={s}
        x={placements.tv.x}
        y={placements.tv.y}
        testId="office-tv"
      />
      {hidden.door ? null : (
        <span
          role="img"
          aria-label={vm.door.label}
          data-testid="office-door"
          data-open={vm.door.open ? 'true' : 'false'}
        >
          <Sprite
            name={vm.door.open ? 'door.open' : 'door.closed'}
            scale={s}
            x={placements.door.x}
            y={placements.door.y}
          />
          {vm.door.open ? null : (
            <span
              className={`${css.label} ${css.doorSign}`}
              aria-hidden="true"
              style={{
                left: (placements.door.x + 3) * s,
                top: (placements.door.y + 7) * s,
              }}
            >
              {vm.door.label}
            </span>
          )}
        </span>
      )}
      <Sprite
        name={vm.yourDesk.lamp === 'amber' ? 'lamp.on' : 'lamp.off'}
        scale={s}
        x={placements.lamp.x}
        y={placements.lamp.y}
        testId="office-lamp"
      />
      {vm.yourDesk.lamp === 'amber' ? (
        <Sprite
          name="lamp.glow"
          scale={s}
          x={placements.lampGlow.x}
          y={placements.lampGlow.y}
        />
      ) : null}
      {vm.yourDesk.paper ? (
        <Sprite
          name="paper.sheet"
          scale={s}
          x={placements.inboxPaper.x}
          y={placements.inboxPaper.y}
        />
      ) : null}
      <Desks vm={vm} scale={s} />
      {vm.paperStacks.map((stack) =>
        hidden.stacks.has(stack.desk) ? null : (
          <Sprite
            key={stack.desk}
            name="paper-stack"
            scale={s}
            x={stack.x}
            y={stack.y - 23}
            frame={stack.sheets - 1}
            testId={`paper-stack-${stack.desk}`}
          />
        ),
      )}
      {vm.parcels.map((parcel) =>
        hidden.parcels.has(parcel.itemKey) ? null : (
          <Sprite
            key={`${parcel.place}-${parcel.itemKey}`}
            name="parcel"
            scale={s}
            x={parcel.x}
            y={parcel.y}
            testId={`parcel-${parcel.itemKey}`}
          />
        ),
      )}
      <span
        className={css.label}
        data-testid="office-conveyor-label"
        style={{ left: 172 * s, top: 162 * s }}
      >
        {vm.conveyor.label}
      </span>
      <span
        className={`${css.label} ${css.cartLabel}`}
        data-testid="office-cart-label"
        style={{ left: 297 * s, top: shiftY(196, rows) * s }}
      >
        {vm.conveyor.cartLabel}
      </span>
    </>
  );
});
