---
"@pracht/adapter-deno": minor
"@pracht/cli": patch
---

Add a Deno adapter that generates a native `Deno.serve` production entry, serves
static assets from `dist/client`, and delegates SSR, route-state, loaders,
middleware, and API routes to Pracht's Web Request/Response runtime.

`pracht preview` now detects Deno targets and runs the built server through
`deno run` with the required read, net, and env permissions.
