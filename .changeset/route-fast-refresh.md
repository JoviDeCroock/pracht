---
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
  components.
- Any route exporting `head` was reported as a head *change* on every edit,
  because the head-bearing walk started at the changed module itself. It now
  starts at that module's importers when the change is a route or shell source,
  and the client entry only reloads when the head hint actually flips.

Adding or removing a `head` export still reloads the document, as does a change
that reaches `defineFont()` state.
