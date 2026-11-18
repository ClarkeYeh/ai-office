import {
  useId,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import styles from './primitives.module.css';

export function PixelFrame({
  attention = false,
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement> & { attention?: boolean }) {
  return (
    <div
      {...props}
      className={`${styles.frame} ${attention ? styles.attention : ''} ${className}`}
    />
  );
}
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  'aria-label': string;
  'data-testid': string;
  variant?: 'secondary' | 'primary' | 'danger' | 'need';
};
export function Button({
  variant = 'secondary',
  className = '',
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={`${styles.button} ${styles[variant] ?? ''} ${className}`}
    />
  );
}
export function Banner({
  tone = 'info',
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: 'info' | 'error' | 'attention' }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      {...props}
      className={`${styles.banner} ${tone === 'error' ? styles.error : tone === 'attention' ? styles.attention : ''} ${className}`}
    />
  );
}
export type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  'data-testid': string;
};
export function Field({
  label,
  hint,
  error,
  id,
  className = '',
  ...props
}: FieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const describedBy =
    [
      props['aria-describedby'],
      hint ? `${inputId}-hint` : '',
      error ? `${inputId}-error` : '',
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <div className={styles.field}>
      <label htmlFor={inputId}>{label}</label>
      <input
        {...props}
        id={inputId}
        aria-label={props['aria-label'] ?? label}
        aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={describedBy}
        className={`${styles.input} ${className}`}
      />
      {hint && (
        <span id={`${inputId}-hint`} className={styles.hint}>
          {hint}
        </span>
      )}
      {error && (
        <span id={`${inputId}-error`} className={styles.invalid}>
          {error}
        </span>
      )}
    </div>
  );
}
const paths = {
  office: 'M2 1h12v14H2z M5 4h6v11H5z',
  flag: 'M3 1h2v14H3z M5 2h9v6H5z',
  attention: 'M7 1h2v9H7z M7 12h2v2H7z',
  check: 'M1 7h3v3h3V7h3V4h3V1h2v5h-3v3H9v3H6v2H3v-3H1z',
} as const;
export function PixelIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      shapeRendering="crispEdges"
    >
      <path d={paths[name]} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
