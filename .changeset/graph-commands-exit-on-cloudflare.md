---
"@pracht/cli": patch
"@pracht/core": patch
"@pracht/vite-plugin": patch
---

Make graph-reading CLI commands terminate on the Cloudflare adapter. `pracht verify`, `doctor`, `inspect`, `typegen`, `plan`, and `report` printed their results and then hung indefinitely, because the short-lived Vite server they boot loaded `@cloudflare/vite-plugin`, which starts workerd and a debugger socket that `server.close()` does not reclaim. Two concurrent invocations also collided on the inspector port. In CI — and in the agent loop the docs prescribe (`pracht verify` must pass, `pracht plan --write`, `pracht report`) — the job simply never finished.

These commands only ever evaluate `virtual:pracht/dev-metadata`, which is adapter-neutral by design, so the CLI now sets `PRACHT_GRAPH_ONLY=1` and the vite plugin omits adapter-contributed plugins for that server. The flag is ref-counted: Vite evaluates the app config asynchronously, so restoring it as soon as one `createServer()` resolved let an overlapping call load the adapter plugins anyway — which the MCP server, serving all of these from one long-lived process, is well placed to trigger.

`pracht verify` on a Cloudflare app went from never exiting to ~1.4s.
