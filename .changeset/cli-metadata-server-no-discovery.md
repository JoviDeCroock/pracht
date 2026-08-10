---
"@pracht/cli": patch
---

Stop the CLI's app-graph server from pre-bundling dependencies.

`pracht inspect`, `plan`, `report`, graph-aware `verify`, and the MCP server
each boot a silent middleware-mode Vite server, evaluate one SSR module to read
the resolved app graph, and close it again — it never answers a browser
request. Dependency discovery was still running, and it outlives
`server.close()`: the scan keeps writing `node_modules/.vite/deps_temp_*` after
the command has moved on. Passing `optimizeDeps: { noDiscovery: true }` skips
work these commands never use and stops them leaving a partial optimizer cache
behind.
