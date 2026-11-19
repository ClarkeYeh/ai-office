import { createRedactor } from '@ai-office/redaction';
/** Keep projection-relevant events, not private command arguments or timer churn.
 * Logical replay time is one second per retained event, rooted at the Unix epoch.
 * @param {Array<Record<string,unknown>>} events
 */
export function normalizeEvents(events) {
  const ids = new Map();
  const branches = new Map();
  const redactor = createRedactor({
    preservedRepoUrls: ['https://github.com/ClarkeYeh/ai-office-spike'],
  });
  const selected = events.filter(
    (e) => !/^(command\.|timer\.|health\.|error\.)/.test(String(e.type)),
  );
  const start = /** @type {{payload?:{shortId?:string}}} */ (
    selected.find((e) => e.type === 'workflow.started')
  );
  const shortId = start?.payload?.shortId;
  /** @returns {unknown} */
  const normalize = (/** @type {unknown} */ value, key = '') => {
    if (typeof value === 'string') {
      let result = value;
      if (
        (key === 'branch' || key === 'integrationBranch') &&
        result.includes('<redacted>')
      )
        result = 'ai-office/masked';
      result = result.replace(
        'https://github.com/ai-office-fake/demo',
        'https://github.com/ClarkeYeh/ai-office-spike',
      );
      if (
        result.startsWith('ai-office/') &&
        result !== 'ai-office/v1alpha1' &&
        !result.includes('{')
      ) {
        if (!branches.has(result))
          branches.set(result, 'ai-office/b' + (branches.size + 1));
        result = branches.get(result);
      }
      if (shortId) result = result.replaceAll(shortId, '000000000001');
      result = result.replace(/\b[a-f0-9]{64}\b/g, '0'.repeat(64));
      result = result.replace(/[0-9A-HJKMNP-TV-Z]{26}/g, (id) => {
        if (!ids.has(id)) ids.set(id, String(ids.size + 1).padStart(26, '0'));
        return ids.get(id);
      });
      result = result.replace(
        /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g,
        '1970-01-01T00:00:00.000Z',
      );
      result = result.replace(
        /\/(?:Users|private|var)\/[^\s"']+/g,
        '/fixture/path',
      );
      return redactor.maskText(result);
    }
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, normalize(v, k)]),
      );
    return value;
  };
  const normalizedEvents = selected.map((event, index) => {
    const rest = { ...event };
    delete rest.externalKey;
    delete rest.causationId;
    delete rest.id;
    const normalized = /** @type {Record<string,unknown>} */ (normalize(rest));
    normalized.seq = index + 1;
    normalized.id = String(index + 1).padStart(26, '0');
    normalized.occurredAt = normalized.recordedAt = new Date(
      index * 1000,
    ).toISOString();
    return normalized;
  });
  return normalizedEvents;
}
