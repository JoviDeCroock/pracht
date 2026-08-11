---
"@pracht/core": patch
"@pracht/image": patch
"@pracht/preact-ssr-precompile": patch
---

Widen the `preact` peer range to accept 11.x prereleases.

The peer was `^10.0.0` (`^10.26.0` for the precompiler), so installing pracht
alongside `preact@11.0.0-beta.x` or `11.0.0-rc.0` printed peer warnings on
every install even though nothing was actually broken. The range is now
`^10.0.0 || ^11.0.0-0`, matching what `preact-render-to-string` already
declares.

The only preact internals pracht touches are the `options` hooks in the
dev-only hydration-mismatch warning, which is installed behind
`import.meta.env.DEV` and degrades to silence if the hooks it taps are never
called. The SSR precompiler's `jsxTemplate` / `jsxAttr` / `jsxEscape` helpers
are still exported from `preact/jsx-runtime` in 11. CI still runs against
preact 10 — 11 is permitted, not yet verified.
