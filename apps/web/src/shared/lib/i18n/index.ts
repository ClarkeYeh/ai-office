import { zhTW } from './zh-TW.js';
export { zhTW } from './zh-TW.js';
export type MessageKey = keyof typeof zhTW;
export type MessageParams = Readonly<Record<string, string | number>>;
export type Translator = (key: MessageKey, params?: MessageParams) => string;
export const locale = 'zh-TW';
/** Product vocabulary intentionally retained in English (D3). */
export const retainedTerms = [
  'PR',
  'merge queue',
  'gate',
  'Claude Code',
  'Codex',
  'token',
  'rework',
  'Repo',
] as const;
export function hasMessage(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(zhTW, key);
}
export const t: Translator = (key, params = {}) =>
  zhTW[key].replace(/\{(\w+)\}/g, (placeholder: string, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name)
      ? String(params[name])
      : placeholder,
  );

export type CodeNamespace =
  'repoWarning' | 'scmWarning' | 'anomaly' | 'policy' | 'apiError';
/** Backend codes are open strings; never treat them as static catalog keys. */
export function tCode(namespace: CodeNamespace, code: string): string {
  if (namespace === 'scmWarning' && code.startsWith('poll_failing:'))
    return t('scmWarning.poll_failing', {
      code: code.slice('poll_failing:'.length),
    });
  const key = `${namespace}.${code}`;
  return hasMessage(key) ? t(key) : t('code.unknown', { code });
}
