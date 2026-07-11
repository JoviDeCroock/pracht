---
"@pracht/core": patch
"@pracht/vite-plugin": patch
"@pracht/cli": patch
---

Emit modulepreload links for the client entry's own static import closure. The client entry statically imports secondary chunks (shared runtime, preload helper), but generated HTML previously only preloaded shell/route chunks — so the browser discovered those imports only after downloading and parsing the entry, adding a serial round trip before hydration. The build now stores each entry's transitive static JS imports in the js manifest under its virtual module id, and both server-rendered and prerendered pages merge them into the page's modulepreload links. Islands pages preload the islands bootstrap's closure; `hydration: "none"` pages still emit no JS at all.
