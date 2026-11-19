/** Controlled transport faults shared by live recording and strict replay.
 * The real response is recorded first. No provider failure or list consistency
 * is claimed: loss and lag are injected locally, using the scenario clock.
 */
export class ContractFaults {
  private lose: 'createIssue' | 'comment' | undefined;
  private lag = 0;
  private hidden = new Map<string, number>();
  constructor(private readonly now: () => number) {}
  loseNextResponse = (operation: 'createIssue' | 'comment') => {
    this.lose = operation;
  };
  listLagMs = (ms: number) => {
    this.lag = ms;
  };
  wrap(transport: typeof fetch): typeof fetch {
    return async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const response = await transport(request);
      if ([204, 205, 304].includes(response.status)) return response;
      const data: unknown = await response.clone().json();
      const operation = /\/issues$/.test(path)
        ? 'createIssue'
        : /\/issues\/\d+\/comments$/.test(path)
          ? 'comment'
          : undefined;
      if (
        request.method === 'POST' &&
        response.ok &&
        operation &&
        data &&
        typeof data === 'object'
      ) {
        const row = data as { number?: number; id?: number };
        this.hidden.set(
          `${operation}:${operation === 'comment' ? row.id : row.number}`,
          this.now() + this.lag,
        );
        if (this.lose === operation) {
          this.lose = undefined;
          throw new Error('Injected response loss');
        }
      }
      if (
        request.method === 'GET' &&
        Array.isArray(data) &&
        /\/issues(?:\/\d+)?(?:\/comments)?$/.test(path)
      ) {
        const kind = path.endsWith('/comments') ? 'comment' : 'createIssue';
        const visible = data.filter(
          (row: { number?: number; id?: number }) =>
            (this.hidden.get(
              `${kind}:${kind === 'comment' ? row.id : row.number}`,
            ) ?? 0) <= this.now(),
        );
        return new Response(JSON.stringify(visible), {
          status: response.status,
          headers: response.headers,
        });
      }
      return response;
    };
  }
}
