/** T6 owns recognition patterns. Never retain or log the in-memory transcript tail. */
export function detectRateLimitPause<T>(
  dispatch: { observation?: { agentWait?: unknown } },
  lastMessage: string | undefined,
  detect: (evidence: {
    agentWait: unknown;
    lastMessage: string | undefined;
  }) => T,
): T {
  return detect({ agentWait: dispatch.observation?.agentWait, lastMessage });
}
