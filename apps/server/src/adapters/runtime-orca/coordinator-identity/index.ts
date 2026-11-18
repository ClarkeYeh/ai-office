export type CommandKind = 'mutate' | 'consume' | 'read';
export interface IdentityContext {
  command: readonly string[];
  mailbox?: { kind: 'run' | 'dispatch'; id: string };
  /** Native `terminal show|read|close` target; validated by argsFor. */
  terminal?: string;
}
export interface IdentityStatus {
  handle: string;
  restored: boolean;
  /** Runs rebound with `run-use` by this call (present when restored). */
  runs?: string[];
}
export interface ThrottleOptions {
  /** Bypass the 30-second throttle (startup, identity errors, consumer_fenced). */
  force?: boolean;
}
/** T4 owns the implementation. Identity flags are never accepted from callers. */
export interface CoordinatorIdentity {
  readonly mode: 'F2-shim-terminal';
  argsFor(
    kind: CommandKind,
    run?: string,
    context?: IdentityContext,
  ): Promise<string[]>;
  ensure(options?: ThrottleOptions): Promise<IdentityStatus>;
  checkOwnership(
    run: string,
    options?: ThrottleOptions,
  ): Promise<'owned' | 'hijacked'>;
}
