import { memo, useCallback, type KeyboardEvent } from 'react';
import type {
  OfficeSeat,
  OfficeViewModel,
  ReservedDesk,
  Room,
} from '../model/index.js';
import {
  characterSprite,
  figureOf,
  INBOX_TRAY,
  WHITEBOARD,
  YOUR_DESK,
} from './geometry.js';
import { Hit } from './Hit.js';
import { SpeechBubble } from './SpeechBubble.js';
import { Nameplate } from './Nameplate.js';
import { Sprite, spriteSize } from './Sprite.js';
import css from './scene.module.css';

// Buttons on the floor: seats (people), reserved desks, your desk, the
// whiteboard, the inbox links and the room plates.

/** "!" bubble: the only persistent reminder animation, 2 frames every 0.9 s. */
const BANG = { duration: 900, iterations: 'infinite' } as const;
/** Typing: 2 frames every 0.6 s. */
const TYPING = { duration: 600, iterations: 'infinite' } as const;
const SEATED = { w: 16, h: 24 };

export function seatRect(seat: OfficeSeat) {
  const figure = figureOf(seat);
  if (!figure) return { x: seat.x, y: seat.y, ...SEATED };
  const size = spriteSize(characterSprite(seat, figure.frame));
  return { x: seat.x + figure.dx, y: seat.y + figure.dy, ...size };
}

export const SeatButton = memo(function SeatButton({
  seat,
  scale: s,
  interactive,
  reducedMotion,
  tabbable,
  walking,
  flash,
  onSelect,
  onKeyDown,
  register,
}: {
  seat: OfficeSeat;
  scale: number;
  interactive: boolean;
  reducedMotion: boolean;
  tabbable: boolean;
  /** Hidden while its walk-in effect plays. */
  walking: boolean;
  flash: boolean;
  onSelect?: ((seatId: string) => void) | undefined;
  onKeyDown: (seatId: string, event: KeyboardEvent<HTMLButtonElement>) => void;
  /** Keeps the button for roving focus. */
  register: (seatId: string, button: HTMLButtonElement | null) => void;
}) {
  const { seatId } = seat;
  const buttonRef = useCallback(
    (button: HTMLButtonElement | null) => register(seatId, button),
    [register, seatId],
  );
  const figure = figureOf(seat);
  const rect = seatRect(seat);
  return (
    <Hit
      interactive={interactive}
      testId={seat.testId}
      ariaLabel={
        seat.bubble ? `${seat.ariaLabel} ${seat.bubble.label}` : seat.ariaLabel
      }
      pressed={seat.selected}
      rect={rect}
      scale={s}
      tabIndex={tabbable ? 0 : -1}
      buttonRef={buttonRef}
      onClick={onSelect && (() => onSelect(seat.seatId))}
      onKeyDown={(event) => onKeyDown(seat.seatId, event)}
      dataset={{
        'data-pose': seat.pose,
        'data-state': seat.state ?? undefined,
        'data-place': seat.place,
      }}
    >
      {figure ? (
        <span className={css.figure} data-hidden={walking ? 'true' : undefined}>
          <Sprite
            name={characterSprite(seat, figure.frame)}
            scale={s}
            x={0}
            y={0}
            animation={figure.animated && !reducedMotion ? TYPING : null}
          />
          {figure.bang ? (
            <Sprite
              name="bang"
              scale={s}
              x={3}
              y={-16}
              animation={reducedMotion ? null : BANG}
              testId={`${seat.testId}-bang`}
            />
          ) : null}
          {figure.smoke ? <Sprite name="smoke" scale={s} x={1} y={-7} /> : null}
        </span>
      ) : null}
      <Nameplate
        plate={seat.nameplate}
        scale={s}
        origin={rect}
        flash={flash}
        compact={seat.place === 'meeting'}
      />
      {seat.bubble && !walking ? (
        <SpeechBubble seat={seat} scale={s} origin={rect} />
      ) : null}
    </Hit>
  );
});

export const ReservedButton = memo(function ReservedButton({
  reserved,
  scale: s,
  interactive,
  flash,
  onSelect,
}: {
  reserved: ReservedDesk;
  scale: number;
  interactive: boolean;
  flash: boolean;
  onSelect?: ((itemKey: string) => void) | undefined;
}) {
  const rect = { x: reserved.x, y: reserved.y, ...SEATED };
  return (
    <Hit
      interactive={interactive}
      testId={reserved.testId}
      ariaLabel={reserved.ariaLabel}
      rect={rect}
      scale={s}
      onClick={onSelect && (() => onSelect(reserved.itemKey))}
    >
      <Nameplate
        plate={reserved.nameplate}
        scale={s}
        origin={rect}
        flash={flash}
      />
    </Hit>
  );
});

export const YourDeskButton = memo(function YourDeskButton({
  desk,
  scale: s,
  interactive,
  reducedMotion,
  flash,
  onOpen,
}: {
  desk: OfficeViewModel['yourDesk'];
  scale: number;
  interactive: boolean;
  reducedMotion: boolean;
  flash: boolean;
  onOpen?: (() => void) | undefined;
}) {
  return (
    <Hit
      interactive={interactive}
      testId={desk.testId}
      ariaLabel={desk.ariaLabel}
      rect={YOUR_DESK}
      scale={s}
      onClick={onOpen}
    >
      {desk.bang ? (
        <Sprite
          name="bang"
          scale={s}
          x={16}
          y={-15}
          animation={reducedMotion ? null : BANG}
          testId="office-your-desk-bang"
        />
      ) : null}
      <Nameplate
        plate={desk.nameplate}
        scale={s}
        origin={YOUR_DESK}
        flash={flash}
      />
    </Hit>
  );
});

export const WhiteboardButton = memo(function WhiteboardButton({
  board,
  scale: s,
  interactive,
  onOpen,
}: {
  board: OfficeViewModel['whiteboard'];
  scale: number;
  interactive: boolean;
  onOpen?: (() => void) | undefined;
}) {
  return (
    <Hit
      interactive={interactive}
      testId={board.testId}
      ariaLabel={board.ariaLabel}
      rect={WHITEBOARD}
      scale={s}
      onClick={onOpen}
    >
      <span
        className={css.whiteboardText}
        aria-hidden="true"
        style={{ fontSize: Math.max(6, Math.round(3.6 * s)) }}
      >
        <span className={css.whiteboardTitle}>{board.title}</span>
        {board.lines.map((line, i) => (
          <span key={i} style={{ display: 'block' }}>
            {line}
          </span>
        ))}
      </span>
    </Hit>
  );
});

export const Inbox = memo(function Inbox({
  inbox,
  scale: s,
  interactive,
  flash,
}: {
  inbox: OfficeViewModel['inbox'];
  scale: number;
  interactive: boolean;
  flash: boolean;
}) {
  return (
    <div
      className={css.inbox}
      role="group"
      aria-label={inbox.ariaLabel}
      data-testid={inbox.testId}
      style={{
        left: (INBOX_TRAY.x + INBOX_TRAY.w + 2) * s,
        top: INBOX_TRAY.y * s,
      }}
    >
      <span
        className={css.plate}
        data-flash={flash ? 'true' : undefined}
        style={{ position: 'static', transform: 'none' }}
      >
        {inbox.label}
      </span>
      {inbox.items.map((item) =>
        interactive && item.url ? (
          <a
            key={item.artifactId}
            className={css.inboxLink}
            href={item.url}
            aria-label={item.label}
            target="_blank"
            rel="noreferrer"
            data-testid={item.testId}
          >
            {item.label}
          </a>
        ) : (
          <span
            key={item.artifactId}
            className={css.inboxLink}
            data-testid={item.testId}
          >
            {item.label}
          </span>
        ),
      )}
    </div>
  );
});

export const RoomPlate = memo(function RoomPlate({
  room,
  scale: s,
  interactive,
  zoomed,
  zoomOutLabel,
  onToggle,
}: {
  room: Room;
  scale: number;
  interactive: boolean;
  zoomed: boolean;
  zoomOutLabel: string;
  onToggle: (id: Room['id']) => void;
}) {
  const style = { left: room.plate.x * s, top: room.plate.y * s };
  if (!interactive)
    return (
      <span className={css.roomPlate} style={style} data-testid={room.testId}>
        {room.label}
      </span>
    );
  return (
    <button
      type="button"
      className={css.roomPlate}
      style={style}
      data-testid={room.testId}
      aria-label={zoomed ? zoomOutLabel : room.ariaLabel}
      aria-pressed={zoomed}
      onClick={() => onToggle(room.id)}
    >
      {room.label}
    </button>
  );
});
