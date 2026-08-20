---
"@pracht/cli": patch
---

`pracht doctor` and `pracht verify` now check static-export preconditions.

Previously both reported "No blocking issues found" for an app whose static build cannot succeed — they printed `Found adapter dependency "@pracht/adapter-static"` and `API route discovery resolved 1 route` in the same run, then passed. The failure only surfaced from `pracht build`, after both the client and server environments had been built.

The live app graph and its generated route metadata already record everything `validateStaticExport` needs for these checks, so the same answer is available in about a second. Doctor and verify use the resolved adapter's authoritative `staticTarget` flag rather than guessing from Vite config source. Built-in static dependencies, inline custom adapters, directly imported local adapters, and otherwise-unrecognized explicit adapter configurations (including quoted `"adapter"` option keys) trigger that resolution, so custom and third-party static adapters are classified correctly even when the project does not depend directly on `@pracht/adapter-static`. Generated loader hints preserve inline route-module loaders without adding fields to committed graph snapshots. Static targets now report routes that render on a server at request time (including an unset `render`, which defaults to SSR), SPA routes with inline or separate loaders, non-full hydration, route middleware, API routes, and capabilities exposed over HTTP/MCP/WebMCP. Messages mirror the build's wording. A static app with none of them gains a passing check instead of silence.

The app-level `notFound` page's two rules (full hydration, no middleware) stay build-time-only, because the graph snapshot does not carry it. Non-static adapters are unaffected.
