# REST client

Create an instance with `createApiClient({ onUnauthorized })`. All requests use
same-origin session cookies; `onUnauthorized` fires once for each HTTP 401,
even when its body cannot be read. No request is cached or automatically retried.
`RequestOptions.signal` supports cancellation; cancellation keeps its original
reason instead of becoming an `ApiError`.

Methods match the JSON operations in `contracts/api`. `ApiBody`, `ApiQuery`, and
`ApiResponse` derive their types from that contract. IDs are encoded as single
path segments. `bootstrapUrl(code)` is for browser navigation; `streamUrl(query)`
is for realtime's EventSource. Agent-token submissions are not browser APIs.

For a gate decision or question answer, create a key **once per user action**:

```ts
const idempotencyKey = createIdempotencyKey();
await api.decideGate(gateId, decision, { idempotencyKey });
// A manual resend of this same decision uses the same body and key.
await api.decideGate(gateId, decision, { idempotencyKey });
```

Keep the key in the calling action's state, including after an uncertain network
failure. Generate a new key for a new/changed decision. The two decision methods
require the key and reject an empty key before sending. `retryable` describes the
error; it never causes an automatic resend. Other mutations follow the existing
contract, which does not provide idempotency headers for them.

`messageSeat(seatId, body)` derives `subject` from the first line, truncated to
60 Unicode code points, and sends the original body. The client does not retain
messages or log them. The calling UI must localize the “automatically generated
subject” label; the server remains responsible for redaction and validation
(including empty first lines).

`ApiError` exposes `status` (0 for transport/local errors), `code`, `category`,
`retryable`, and `details`. Render localized UI text using these fields; diagnostic
`message` is not UI copy. Client fallback codes are `network_error`,
`invalid_response`, and `http_error`; malformed 401s use `unauthorized`.

Response schemas are loaded dynamically only under `import.meta.env.DEV`
(including normal Vitest runs). Validation preserves additive fields instead of
returning Zod's stripped result. Production uses contract types without loading
Zod. Tests compare the handwritten route table to `apiEndpoints`.
