import { PortError } from '../../../ports/errors.js';
import {
  contractMismatch,
  errorBodySchema,
  mapResponseError,
  unavailable,
  type GithubError,
} from '../errors.js';
import { EtagCache } from '../etag.js';
import { GithubGovernor } from '../governor.js';
import { GithubMetrics } from '../metrics.js';
import { prepareRequest, guard, type EndpointId } from '../policy/endpoints.js';
import { nextPage, nextQuery } from './pagination.js';
import { z } from 'zod';
import type {
  GithubHttp,
  GithubHttpOptions,
  GithubResponse,
  RequestOptions,
  RequestParams,
} from './types.js';

/** Bounds every paginated read (100 pages of at most 100 rows). */
export const MAX_PAGES = 100;
const repositoryIdSchema = z.looseObject({ id: z.number().int().positive() });

export class GithubHttpClient implements GithubHttp {
  readonly governor: GithubGovernor;
  readonly metrics: GithubMetrics;
  private cache = new EtagCache();
  /** owner/repo (lower case) → GitHub numeric repository ID, from `repos.get`. */
  private repositoryIds = new Map<string, number>();
  private clock;
  private fetch;
  private token: Promise<string> | undefined;
  private lastRefresh = -Infinity;
  constructor(private options: GithubHttpOptions) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.fetch = options.fetch ?? globalThis.fetch;
    this.governor = new GithubGovernor(
      this.clock,
      options.sleep ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    );
    this.metrics = new GithubMetrics(this.clock);
  }
  private async getToken(refresh: boolean): Promise<string> {
    if (!this.token || refresh) {
      this.token = Promise.resolve()
        .then(() => this.options.tokenProvider({ refresh }))
        .then((token) => {
          if (!token || /[\r\n]/.test(token))
            throw new Error('Invalid credential');
          return token;
        });
    }
    try {
      return await this.token;
    } catch {
      this.token = undefined;
      throw new PortError(
        'auth',
        'github_auth',
        'GitHub credentials are unavailable',
      );
    }
  }
  async request<T>(
    id: EndpointId,
    params: RequestParams,
    options: RequestOptions<T>,
  ): Promise<GithubResponse<T>> {
    // Copy before queuing: caller mutation must not change a validated write.
    params = structuredClone(params);
    options = {
      ...options,
      ...(options.safety ? { safety: structuredClone(options.safety) } : {}),
    };
    prepareRequest(id, params, options, this.options.repoAllowlist);
    const token = await this.getToken(false);
    let response: GithubResponse<T>;
    try {
      response = await this.attempt(id, params, options, token);
    } catch (error) {
      if (
        !(error instanceof PortError) ||
        error.category !== 'auth' ||
        this.clock.now().getTime() - this.lastRefresh < 300_000
      )
        throw error;
      this.lastRefresh = this.clock.now().getTime();
      this.cache.clear();
      const refreshed = await this.getToken(true);
      // Only an explicit 401 is retried; ambiguous writes are never replayed here.
      response = await this.attempt(id, params, options, refreshed);
    }
    if (response.next?.repositoryId !== undefined) {
      await this.assertRepositoryId(params, response.next.repositoryId);
      const { repositoryId: _checked, ...next } = response.next;
      void _checked;
      response = { ...response, next };
    }
    return response;
  }
  private repositoryKey(params: RequestParams): string {
    if (!params.owner || !params.repo) return guard('invalid_pagination');
    return JSON.stringify([
      params.owner.toLowerCase(),
      params.repo.toLowerCase(),
    ]);
  }
  /** A `/repositories/{id}/…` next link must name this request's repository. */
  private async assertRepositoryId(
    params: RequestParams,
    id: number,
  ): Promise<void> {
    const key = this.repositoryKey(params);
    if (!this.repositoryIds.has(key))
      await this.request(
        'repos.get',
        { owner: params.owner!, repo: params.repo! },
        { schema: z.looseObject({}), conditional: false },
      );
    if (this.repositoryIds.get(key) !== id) guard('invalid_pagination');
  }
  private async attempt<T>(
    id: EndpointId,
    params: RequestParams,
    options: RequestOptions<T>,
    token: string,
  ): Promise<GithubResponse<T>> {
    const { spec, write } = prepareRequest(
      id,
      params,
      options,
      this.options.repoAllowlist,
    );
    return this.governor.run(
      write ? 'write' : 'read',
      spec.content,
      async () => {
        const { url } = prepareRequest(
          id,
          params,
          options,
          this.options.repoAllowlist,
        );
        const cached = this.cache.get(url.href);
        // A pinned cursor ETag is sent only while its representation is cached:
        // after a restart, eviction or write invalidation a 304 could not be served.
        const etag =
          typeof options.conditional === 'string'
            ? cached?.etag === options.conditional
              ? options.conditional
              : undefined
            : options.conditional
              ? cached?.etag
              : undefined;
        const headers = new Headers({
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': `ai-office/${this.options.version ?? '0.0.0'}`,
        });
        if (etag && !write) headers.set('If-None-Match', etag);
        if (write && spec.body) headers.set('Content-Type', 'application/json');
        const start = this.clock.now().getTime();
        let status = 0,
          failed = true;
        try {
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          let response: Response, raw: string;
          try {
            [response, raw] = await Promise.race([
              (async () => {
                const response = await this.fetch(url.href, {
                  method: spec.method,
                  headers,
                  redirect: 'manual',
                  signal: controller.signal,
                  ...(spec.body ? { body: JSON.stringify(params.body) } : {}),
                });
                return [response, await response.text()] as const;
              })(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(unavailable(spec.uncertain));
                }, this.options.timeoutMs ?? 30_000);
              }),
            ]);
          } catch {
            throw unavailable(spec.uncertain);
          } finally {
            if (timer) clearTimeout(timer);
          }
          status = response.status;
          this.governor.observe(response.headers);
          if (status >= 300 && status < 400 && status !== 304)
            guard('github_redirect_not_allowed');
          if (status === 304) {
            if (write || !cached || !etag || cached.etag !== etag)
              throw contractMismatch();
            const parsed = options.schema.safeParse(
              structuredClone(cached.data),
            );
            if (!parsed.success) throw contractMismatch();
            failed = false;
            return {
              data: parsed.data,
              status,
              etag: cached.etag,
              notModified: true,
              ...(cached.next ? { next: cached.next } : {}),
            };
          }
          let value: unknown;
          try {
            value = raw ? JSON.parse(raw) : undefined;
          } catch {
            if (response.ok) throw contractMismatch();
          }
          if (!response.ok) {
            const parsed = errorBodySchema.safeParse(value);
            const message = parsed.success ? (parsed.data.message ?? '') : '';
            const error =
              this.governor.failure(
                status,
                response.headers,
                message,
                write ? 'write' : 'read',
              ) ?? mapResponseError(status, value, spec.uncertain);
            throw this.diagnostic(
              error,
              status,
              response.headers.get('x-github-request-id'),
              message,
              token,
              params.body,
            );
          }
          const parsed = options.schema.safeParse(value);
          if (!parsed.success) throw contractMismatch();
          if (id === 'repos.get') {
            const repository = repositoryIdSchema.safeParse(value);
            if (repository.success)
              this.repositoryIds.set(
                this.repositoryKey(params),
                repository.data.id,
              );
          }
          const next = nextPage(response.headers.get('link'), url);
          const responseEtag = response.headers.get('etag');
          if (!write && responseEtag)
            this.cache.set(url.href, {
              etag: responseEtag,
              data: parsed.data,
              ...(next ? { next } : {}),
            });
          // Invalidate all representations after writes, including ambiguous outcomes below.
          if (write) this.cache.clear();
          failed = false;
          return {
            data: parsed.data,
            status,
            notModified: false,
            ...(responseEtag ? { etag: responseEtag } : {}),
            ...(next ? { next } : {}),
          };
        } finally {
          if (!failed) this.governor.success();
          if (write && failed) this.cache.clear();
          this.metrics.record(
            id,
            Math.max(0, this.clock.now().getTime() - start),
            status,
            failed,
          );
        }
      },
    );
  }
  private diagnostic(
    error: GithubError,
    status: number,
    requestId: string | null,
    message: string,
    token: string,
    body: unknown,
  ): GithubError {
    // Strip exact in-memory inputs before shared secret masking and truncation.
    const inputs: string[] = [token];
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && value) inputs.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object')
        Object.values(value).forEach(collect);
    };
    collect(body);
    const mask = (text: string) =>
      this.options.maskSecrets(
        inputs
          .sort((a, b) => b.length - a.length)
          .reduce(
            (value, secret) => value.split(secret).join('<redacted>'),
            text,
          ),
      );
    error.status = status;
    if (requestId) error.requestId = mask(requestId).slice(0, 100);
    // Network/5xx messages may contain submitted content; keep fixed outcome text.
    if (message && status < 500)
      error.message = `${error.message}: ${mask(message).slice(0, 200)}`;
    return error;
  }
  async paginate<T>(
    id: EndpointId,
    params: RequestParams,
    options: RequestOptions<T[]>,
  ): Promise<T[]> {
    if (prepareRequest(id, params, options, this.options.repoAllowlist).write)
      guard('pagination_requires_read');
    const data: T[] = [];
    let query = {
      ...params.query,
      per_page: params.query?.per_page ?? 100,
      page: Number(params.query?.page ?? 1),
    };
    const seen = new Set<string>();
    for (let count = 0; count < MAX_PAGES; count++) {
      const response = await this.request(id, { ...params, query }, options);
      data.push(...response.data);
      if (response.next === undefined) return data;
      const key = JSON.stringify(nextQuery(response.next));
      if (seen.has(key)) guard('pagination_repeated');
      seen.add(key);
      query = { ...query, ...nextQuery(response.next) };
    }
    return guard('pagination_limit');
  }
}
