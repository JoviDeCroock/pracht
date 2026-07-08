---
"@pracht/core": minor
---

Add navigation UX primitives: `useNavigation()`, scroll restoration, a public `<Link>` prefetch API, and View Transitions integration.

- **`useNavigation()`** — reactive pending state for the current client navigation or `<Form>` submission. Returns `{ state: "idle" | "loading" | "submitting", location?, formData? }` and updates through the router's full lifecycle (nav start → route-state fetch → commit → idle). Enables global progress bars, pending buttons, and optimistic UI (`formData` holds the in-flight submission values).
- **Scroll restoration** — the client router now owns scrolling (`history.scrollRestoration = "manual"`). Back/forward navigations restore the previous scroll position (keyed per history entry, `sessionStorage`-backed so it survives reloads); new navigations scroll to the top or to the `#hash` target. Opt out per navigation with `<Link preserveScroll>` or `navigate(to, { preserveScroll: true })`. **Behavior improvement:** previously every navigation (including back/forward) reset scroll to the top — back/forward now restores position by default, matching peer frameworks.
- **`<Link prefetch>`** — the existing bounded prefetch cache is now controllable per link: `"intent"` (hover/focus, the existing default), `"viewport"` (IntersectionObserver), `"render"` (on mount), or `"none"`. Route-level `prefetch` meta still sets the default; navigations consume prefetched route state without a second request, and failed prefetches are evicted from the cache. Also adds an imperative `prefetch(hrefOrRouteTarget)` export.
- **View Transitions** — opt in per navigation via `<Link viewTransition>` / `navigate(to, { viewTransition: true })`, or app-wide via `defineApp({ viewTransitions: true })`. The DOM commit is wrapped in `document.startViewTransition()` when available and falls back to an instant commit otherwise.
