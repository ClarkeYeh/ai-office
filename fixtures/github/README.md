# GitHub REST fixtures

Store sanitized recordings under `<api-version>/` (initially `2022-11-28/`),
using `<scenario>.<step>.json`. Each file has this envelope:

```ts
{
  apiVersion: string;
  recordedAt: string; // ISO timestamp
  method: string;
  pathTemplate: string; // REST template, not a raw URL containing private values
  query: Record<string, string>;
  requestBodySha256?: string;
  status: number;
  headers: Record<string, string>;
  response: unknown;
}
```

T7 owns recording, sanitization and replay through injected `fetch`. Preserve only
response headers on the allowlist: `etag`, `x-ratelimit-*`, `retry-after`, `link`,
`x-github-request-id`, and `date`; status is a separate envelope field. Never record
authorization or other request headers, credentials, transcript text, or raw private
body text. Sanitize response bodies using the shared redaction package; recover
known synthetic body text by SHA-256 for replay assertions about markers and hashes.
Do not commit raw recordings. Run `pnpm fixtures:scan` before committing fixtures.

Default tests and coverage use offline replay only. Live recording is restricted to
`ClarkeYeh/ai-office-spike`, explicitly authorized operators, and the T7 safety gate.
`github:record` and `github:janitor` fail closed until M3-T7 implements them.
