import type { CSSProperties, KeyboardEvent, ReactNode, Ref } from 'react';
import css from './scene.module.css';

export type HitProps = {
  interactive: boolean;
  testId: string;
  ariaLabel: string;
  pressed?: boolean;
  /** World rectangle at 1×. */
  rect: { x: number; y: number; w: number; h: number };
  scale: number;
  onClick?: (() => void) | undefined;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  tabIndex?: number;
  buttonRef?: Ref<HTMLButtonElement>;
  className?: string;
  style?: CSSProperties;
  dataset?: Record<`data-${string}`, string | undefined>;
  children?: ReactNode;
};

/**
 * A real `<button>` over part of the floor (M4_DESIGN §5.1). A non-interactive
 * scene (the gate thumbnail) renders the same box as an inert `<div>`.
 */
export function Hit({
  interactive,
  testId,
  ariaLabel,
  pressed,
  rect,
  scale: s,
  onClick,
  onKeyDown,
  tabIndex,
  buttonRef,
  className,
  style,
  dataset,
  children,
}: HitProps) {
  const box: CSSProperties = {
    left: rect.x * s,
    top: rect.y * s,
    width: rect.w * s,
    height: rect.h * s,
    ...style,
  };
  const cls = [css.hit, className].filter(Boolean).join(' ');
  if (!interactive)
    return (
      <div
        className={cls}
        style={box}
        data-testid={testId}
        data-interactive="false"
        {...dataset}
      >
        {children}
      </div>
    );
  return (
    <button
      ref={buttonRef}
      type="button"
      className={cls}
      style={box}
      data-testid={testId}
      aria-label={ariaLabel}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      {...(tabIndex === undefined ? {} : { tabIndex })}
      onClick={onClick}
      onKeyDown={onKeyDown}
      {...dataset}
    >
      {children}
    </button>
  );
}
