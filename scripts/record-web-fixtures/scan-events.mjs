import { DomainEventSchema } from '../../packages/contracts/dist/events/index.js';

/** Domain events carry numeric usage and structured artifacts, not transcripts.
 * Reject private event types/fields before recursively scanning every string/key.
 * @param {unknown} value
 * @param {{maskText:(text:string)=>string}} redactor
 */
export function safeWebEvents(value, redactor) {
  if (!Array.isArray(value) || value.length === 0) return false;
  /** @param {unknown} item @returns {boolean} */
  function safe(item) {
    if (typeof item === 'string') return redactor.maskText(item) === item;
    if (Array.isArray(item)) return item.every(safe);
    if (item && typeof item === 'object')
      return Object.entries(item).every(
        ([key, child]) =>
          !/(?:transcript|rawBlocks|^blocks$|prompt|seatToken|authorization|cookie|password|secret|api[_-]?key|stdout|stderr)/i.test(
            key,
          ) &&
          safe(key) &&
          safe(child),
      );
    return true;
  }
  return value.every((event) => {
    const parsed = DomainEventSchema.safeParse(event);
    return (
      parsed.success &&
      !/^(?:command\.|timer\.|health\.|error\.)/.test(parsed.data.type) &&
      safe(event)
    );
  });
}
