---
"@pracht/vite-plugin": patch
---

Fix the dev server dropping all but the last `Set-Cookie` header and corrupting binary response bodies, and log loader, middleware, and render failures to the dev terminal.
