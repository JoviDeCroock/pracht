---
"@pracht/vite-plugin": patch
---

Reload the page in dev when a server-only module changes. Routes using
`hydration: "islands"` or `hydration: "none"` are excluded from the client
bundle, so their source files never enter the client module graph and Vite had
no module to push an update through — editing them left the open page stale
until a manual refresh. Files that exist only in the server graph now trigger a
full reload, while anything with a client module (islands, full-hydration
routes) keeps its granular HMR.
