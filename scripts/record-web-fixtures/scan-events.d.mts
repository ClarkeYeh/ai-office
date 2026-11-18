export type TextScanner = { maskText(text: string): string };
export function safeWebEvents(
  value: unknown,
  redactor: { maskText(text: string): string },
): boolean;
