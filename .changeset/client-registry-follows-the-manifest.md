---
"@pracht/vite-plugin": patch
---

Keep files the app manifest never names out of the client bundle, so a draft route, a scratch copy, or a route deleted from the manifest but left in `src/routes/` is no longer compiled and published with its source. A manifest that imports its routes from another module or builds a specifier at runtime keeps the previous directory-wide registry.
