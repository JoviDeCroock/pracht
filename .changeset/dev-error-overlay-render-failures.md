---
"@pracht/core": minor
"@pracht/vite-plugin": patch
---

Render loader, middleware, and render failures in the dev error overlay
instead of a plain-text dump.

`handlePrachtRequest()` answers a page failure that no `ErrorBoundary` claims
with a `text/plain` body. That is correct for a production adapter and wrong
for a browser in dev — worst of all for a syntax error in a route file, whose
compiler diagnostic arrives colourized for a terminal and rendered every
escape sequence literally, wrapping each character of the offending line in
`[38;5;249m`.

The dev SSR middleware now captures the raw error through `onRouteError` and
serves the overlay instead, with clickable stack frames and open-in-editor
links. `buildErrorOverlayHtml()` strips ANSI escapes from the message and
stack, keeps multi-line diagnostics readable with `white-space: pre-wrap`, and
gained `phase`, `loaderFile`, and `shellFile` rows. `onRouteError` receives a
third `RouteErrorContext` argument carrying that metadata.

A route or shell `ErrorBoundary` still renders its own output, and route-state
requests still fail as JSON.

The overlay itself gained fixes found while reviewing this change: it keeps the
framework's default security headers, honours the runtime's
`NODE_ENV=production` redaction instead of printing the internals the body just
withheld, declares its auto-reload block as a module (`import.meta` is a parse
error in a classic script, so the block was silently dropped), and no longer
mangles OSC terminal hyperlinks — the sequence miette, and therefore oxc, emits
for diagnostic codes.

The handoff now identifies declared route and shell error boundaries explicitly
instead of inferring them from `Content-Type`, preserves `Server-Timing` on the
overlay response, and retains a separately wired loader path when that module
fails during import.
