import type { SessionStore } from '../../ports/stores.js';

/** The store owns atomic consumption, hashed persistence and expiry. */
export class SessionService {
  constructor(private readonly store: SessionStore) {}
  exchangeBootstrapCode(code: string): string | null {
    return this.store.exchangeBootstrapCode(code);
  }
  verify(session: string): boolean {
    return this.store.verify(session);
  }
  revoke(session: string): void {
    this.store.revoke(session);
  }
}
