import type { AdapterStateStore } from '../ports/stores.js';

/** JSON round trips match durable storage and prevent callers mutating state. */
export class MemoryAdapterStateStore implements AdapterStateStore {
  private readonly values = new Map<string, string>();
  read(scope: string): unknown | null {
    const value = this.values.get(scope);
    return value === undefined ? null : JSON.parse(value);
  }
  write(scope: string, value: unknown): void {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new TypeError('Value is not JSON serializable');
    this.values.set(scope, encoded);
  }
}
