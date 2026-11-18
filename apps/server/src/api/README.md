# REST and session wiring

T33 calls `await registerApi(app, deps)` before listening on **127.0.0.1**.
Dependencies are:

- `commands`: `createCommandFacade(...)` (T27).
- `queries`: `new QueryService(...)` (T29).
- `templates`: `new TemplateQueries(templateRepository)`.
- `sessions`: `new SessionService(sessionStore)`.
- `stream`: `new StreamService(eventStore)` (T29/T31).
- `port`: the actual listening port; `dev` and `devOrigin` are optional.

The session store issues the bootstrap code at startup. It atomically consumes
that code within 60 seconds and persists only hashes of codes and 30-day session
secrets. The API exchanges the code for an HttpOnly, SameSite=Strict cookie and
redirects to `/`. Bootstrap request logging is disabled at route level to avoid
logging the query credential. Do not add a parent request logger that records
raw URLs or cookies.

`registerApi` encapsulates its cookie plugin, schema compilers and error handler.
It registers the stream itself with the exported `requireSession(deps)` hook;
**do not register the stream again**. REST authentication runs before body parsing
and validation. All API reads, writes, unknown paths and streams check the raw
Host and session. Writes require Origin; supplied Origins on reads are also
checked. Only explicit dev mode adds the configured dev origin. Vite must proxy
with a backend Host that matches the configured port.

Register the T32 agent gateway separately. It owns seat-token authentication,
Host checks and unconditional rejection of any Origin; it must never inherit
browser cookie authentication.

`USE_CASE_ERRORS` is the single use-case/public-code translation table. Public
HTTP status and category come from `API_ERRORS`, including the intentional
409-to-422 translation of `idempotency_mismatch`. Unknown failures return a
sanitized 500. Adapter categories have registered fallback codes and fixed HTTP
statuses. Raw exception messages/details are never returned.

Contract source additions in this task are additive. The generated schema and
OpenAPI files retain the existing shared `$ref` generation.
