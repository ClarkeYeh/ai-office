import type { NextPage } from './http/pagination.js';
/** Bounded in-memory representations; values never leave the adapter as diagnostics. */
export class EtagCache {
  private entries = new Map<
    string,
    { etag: string; data: unknown; next?: NextPage }
  >();
  constructor(private capacity = 500) {}
  get(url: string) {
    return this.entries.get(url);
  }
  set(
    url: string,
    entry: { etag: string; data: unknown; next?: NextPage },
  ): void {
    this.entries.delete(url);
    this.entries.set(url, structuredClone(entry));
    if (this.entries.size > this.capacity)
      this.entries.delete(this.entries.keys().next().value!);
  }
  clear(): void {
    this.entries.clear();
  }
}
