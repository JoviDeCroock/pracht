---
"@pracht/core": minor
"@pracht/vite-plugin": patch
---

Give route, shell, and head-bearing modules Preact Fast Refresh in dev.

Editing anything under `src/routes/` or `src/shells/` triggered a full page
reload, wiping client state on every save — while a component in
`src/components/` refreshed in place. Two independent causes:

- `@prefresh/vite` filters on ids ending in `.tsx`/`.jsx`, and pracht loads
  route and shell modules in the browser as `?pracht-client` variants so its
  post transform can strip server-only exports. Prefresh skipped exactly those
  modules, so no `import.meta.hot.accept` was injected and the update
  propagated to the non-accepting virtual client entry. A new
  `pracht:client-module-prefresh` plugin runs prefresh's transform for those
  ids, ordered after the strip so prefresh sees a module whose exports are only
  components. Compiled Markdown, MDX, `.tsrx`, and configured route formats use
  a synthetic JSX id so the same refresh instrumentation covers them after
  their companion Vite transform runs.
- Any route exporting `head` was reported as a head *change* on every edit,
  because the head-bearing walk started at the changed module itself. It now
  starts at that module's importers when the change is a route or shell source,
  and the client entry only reloads when the head hint actually flips.

Adding or removing a `head` export still reloads the document, as does a change
that reaches `defineFont()` state.

Fast Refresh alone would have been a downgrade for data: a route module's
`loader`, `head`, `headers`, and `getStaticPaths` are stripped out of the
browser copy, so patching the component in place leaves the page holding data
the server would no longer send — something the old full reload hid by
re-fetching everything. The dev server now sends a `pracht:route-data-stale`
HMR event after a route or shell update, and the generated client entry
re-fetches route state through the same path `useRevalidate()` uses. Data is as
fresh as the reload made it, and client state survives. The whole path is dead
code in a production build.
