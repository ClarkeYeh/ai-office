// Compatibility facade: the shared catalog owns all office and board strings.
export { officeMessagesZhTW } from '../../../shared/lib/i18n/office.js';
import type { officeMessagesZhTW } from '../../../shared/lib/i18n/office.js';
export type OfficeMessageKey = keyof typeof officeMessagesZhTW;
export type MessageParams = Readonly<Record<string, string | number>>;
export type Translate = (
  key: OfficeMessageKey,
  params?: MessageParams,
) => string;
