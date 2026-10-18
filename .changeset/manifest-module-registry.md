---
"@pracht/vite-plugin": patch
"@pracht/cli": patch
---

Route, shell, and middleware modules outside the configured directories now load when the manifest names them as string literals, and `pracht build` fails, naming each ref, when a manifest ref matches no module instead of shipping a route that 500s on every request.
