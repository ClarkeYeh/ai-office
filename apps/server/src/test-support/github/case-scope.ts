/** A case owns its lock until all in-flight work has drained and cleanup finishes. */
export class GithubCaseScope {
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  private disposal?: Promise<void>;
  constructor(readonly signal?: AbortSignal) {}
  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.signal?.aborted)
      return Promise.reject(new Error('GitHub case aborted'));
    const promise = Promise.resolve().then(() => {
      if (this.closed || this.signal?.aborted)
        throw new Error('GitHub case aborted');
      return operation();
    });
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  dispose(cleanup: () => Promise<void>): Promise<void> {
    this.closed = true;
    this.disposal ??= (async () => {
      await Promise.allSettled([...this.pending]);
      await cleanup();
    })();
    return this.disposal;
  }
}
