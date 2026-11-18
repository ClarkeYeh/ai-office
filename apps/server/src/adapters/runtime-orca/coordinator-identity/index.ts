export type CommandKind = 'mutate' | 'consume' | 'read';
export interface IdentityContext {
  command: readonly string[];
  mailbox?: { kind: 'run' | 'dispatch'; id: string };
}
export interface IdentityStatus {
  handle: string;
  restored: boolean;
}
/** T4 owns the implementation. Identity flags are never accepted from callers. */
export interface CoordinatorIdentity {
  readonly mode: 'F2-shim-terminal';
  argsFor(
    kind: CommandKind,
    run?: string,
    context?: IdentityContext,
  ): Promise<string[]>;
  ensure(): Promise<IdentityStatus>;
  checkOwnership(run: string): Promise<'owned' | 'hijacked'>;
}
