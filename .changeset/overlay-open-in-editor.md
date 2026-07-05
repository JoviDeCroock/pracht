---
"@pracht/core": minor
"@pracht/vite-plugin": minor
---

Dev error overlay: stack frames and the reported file path are now clickable and open the file at the exact line/column in your editor via Vite's built-in `/__open-in-editor` endpoint. App-code frames are parsed from the stack (handling `file://` URLs, `/@fs/` prefixes, Vite transform queries, and root-relative dev-server URLs), while `node_modules` and Node-internal frames are de-emphasized and never linked.

Manifest wiring mistakes now fail loudly with "did you mean" hints: referencing an unknown shell or middleware name (including `api.middleware`) throws during `resolveApp()`, and unknown route ids throw from `href()`/`buildHref()`, each listing the closest match and all registered names, e.g. `Unknown shell "pubic" for route "/". Did you mean "public"? Registered shells: public, app.` These errors surface in the dev error overlay as soon as the dev server loads the manifest.
