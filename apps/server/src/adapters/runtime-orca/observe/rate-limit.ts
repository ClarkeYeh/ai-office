/**
 * S26 provider usage-limit recognition (SPEC §7.1, §11.1; provisional). Pure and
 * in-memory only: callers pass the transcript tail transiently and must never log
 * or persist it. The table is data so new provider wording is a one-line change.
 */
export type RateLimitEvidence = {
  evidence: 'worker-show' | 'transcript';
  resetsAt?: string;
};
export type RateLimitPattern = {
  provider: 'claude' | 'codex';
  pattern: RegExp;
};
export const RATE_LIMIT_PATTERNS: readonly RateLimitPattern[] = [
  { provider: 'claude', pattern: /\bclaude (?:ai )?usage limit reached\b/i },
  {
    provider: 'claude',
    pattern: /\b(?:5-hour|five-hour|weekly|session|opus) limit reached\b/i,
  },
  {
    provider: 'claude',
    pattern: /\byou(?:'|’)ve hit your (?:usage )?limit\b/i,
  },
  { provider: 'codex', pattern: /\byou(?:'|’)ve hit your usage limit\b/i },
  { provider: 'codex', pattern: /\busage limit (?:reached|exceeded)\b/i },
  { provider: 'codex', pattern: /\brate limit(?:ed)? (?:reached|exceeded)\b/i },
];
const WAIT_KIND = /rate.?limit|usage.?limit|quota/i;

function resetFrom(text: string): string | undefined {
  // Claude's legacy `...limit reached|<epoch seconds>` form, or an explicit ISO stamp.
  const epoch = /\|(\d{10})\b/.exec(text)?.[1];
  if (epoch) return new Date(Number(epoch) * 1000).toISOString();
  const iso =
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/.exec(
      text,
    )?.[0];
  if (iso && !Number.isNaN(Date.parse(iso)))
    return new Date(Date.parse(iso)).toISOString();
  // Wall-clock wording ("resets 3pm") has no reliable date: omit resetsAt.
  return undefined;
}
function waitEvidence(agentWait: unknown): RateLimitEvidence | null {
  if (!agentWait || typeof agentWait !== 'object') return null;
  const wait = agentWait as Record<string, unknown>;
  const kind = [wait.kind, wait.reason, wait.type]
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
  if (!WAIT_KIND.test(kind)) return null;
  const raw = [wait.resetsAt, wait.resetAt, wait.until].find(
    (v) => typeof v === 'string' || typeof v === 'number',
  );
  const at =
    typeof raw === 'number'
      ? raw < 1e12
        ? raw * 1000
        : raw
      : typeof raw === 'string'
        ? Date.parse(raw)
        : NaN;
  return {
    evidence: 'worker-show',
    ...(Number.isNaN(at) ? {} : { resetsAt: new Date(at).toISOString() }),
  };
}

/** Best effort: `worker-show` agentWait evidence wins over transcript wording. */
export function detectRateLimit(input: {
  agentWait?: unknown;
  lastMessage?: string | undefined;
}): RateLimitEvidence | null {
  const wait = waitEvidence(input.agentWait);
  if (wait) return wait;
  const text = input.lastMessage;
  if (!text || !RATE_LIMIT_PATTERNS.some(({ pattern }) => pattern.test(text)))
    return null;
  const resetsAt = resetFrom(text);
  return { evidence: 'transcript', ...(resetsAt ? { resetsAt } : {}) };
}
