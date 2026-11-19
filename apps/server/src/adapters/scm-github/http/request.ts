import type { z } from 'zod';
export type RequestParams = {
  owner?: string;
  repo?: string;
  number?: number;
  id?: number;
  ref?: string;
  branch?: string;
  base?: string;
  head?: string;
  sha?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};
export type RequestOptions<T> = {
  schema: z.ZodType<T>;
  /** true uses the HTTP cache; a string pins the caller's cursor ETag. */
  conditional?: boolean | string;
  /** Evidence fetched by the method layer immediately before destructive calls. */
  safety?: {
    defaultBranch?: string;
    protected?: boolean;
    author?: string;
    viewer?: string;
    body?: string;
    commandId?: string;
    actualBase?: string;
  };
};
