import { API, ROOT } from './safety.js';
export type JsonObject = Record<string, unknown>;
export class GithubApi {
  constructor(readonly fetch: typeof globalThis.fetch) {}
  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: JsonObject }> {
    const response = await this.fetch(`${API}${ROOT}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok && response.status !== 404)
      throw new Error(`GitHub harness HTTP ${response.status}`);
    return {
      status: response.status,
      data:
        response.status === 204 || response.status === 404
          ? {}
          : ((await response.json()) as JsonObject),
    };
  }
  async list(path: string): Promise<JsonObject[]> {
    const rows: JsonObject[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.fetch(
        `${API}${ROOT}${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      );
      if (!response.ok) throw new Error('GitHub inventory failed');
      const data: unknown = await response.json();
      if (!Array.isArray(data)) throw new Error('Invalid GitHub inventory');
      rows.push(...(data as JsonObject[]));
      if (data.length < 100) return rows;
    }
    throw new Error('GitHub inventory exceeds safety bound');
  }
}
