# App shell integration

`AppProviders` owns one API client and realtime instance for its lifetime and
closes the stream on unmount or API 401. Tests may supply `AppServices` to `App`.
Bootstrap exchange stays on the server (`/auth/bootstrap` redirects to `/`).
`AuthGate` gives the same restart instruction for REST and SSE authentication loss.

Add feature entry components via their public `index.ts` to `routes.tsx`.
Each `Page` receives `{ route: { name, params }, api }`; hooks for server state
come from `realtime/index.ts`. `Link` and `useNavigation` are public in
`shared/ui` so features never import `app/`. Route matching is in `router.ts`.
Feature routes currently show a localized preparation message until their
own task supplies a page; the shell does not implement those features.

`Shell` accepts `children` (page), `office`, `legend`, `rightColumn`, `banners`,
`needs`, and `stages`. Office scenes must go in `office`: it is not mounted
below 900px. The right column always starts with needs and ends with usage.
When wiring richer feature layouts, compose these slots in app/ rather than
letting a feature import Shell. Interactive primitives require stable test IDs
and accessible labels. Only one button per screen should use `primary`.

`t`, `MessageKey`, `MessageParams`, `hasMessage`, and `zhTW` live in
`shared/lib/i18n/index.ts`. New feature copy belongs in this catalog; selectors
receive `t` as a parameter. The office model's old messages module is a
compatibility facade over the shared office catalog, not a second translation.

## Visual review

[Desktop](./evidence/desktop.png) and [390px mobile](./evidence/mobile.png)
show Shell with synthetic props: an open gate, hijack pause, stage progress,
usage, and placeholder page/right-column slots. These are shell evidence,
not screenshots of completed downstream features. Playwright 1.61.1 with its bundled Chromium produced
both with no page errors; mobile document width was 390px and the office
slot was absent from the DOM. The office selector label remains visible
on mobile; its content is intentionally replaced by the desktop notice.
