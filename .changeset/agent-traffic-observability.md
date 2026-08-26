---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
---

Make agent traffic observable: composable audit sinks, a dev Agents panel, and `pracht inspect agents`.

Named audit listeners now compose safely with existing hooks and dev HMR. In
development, `/_pracht` records recent capability dispatches while distinguishing
trusted agent attribution from unverified HTTP and WebMCP markers, and the new CLI
and MCP inspection commands summarize agent policies, transports, and discovery.
Audit callbacks run synchronously and should stay cheap; returned promises are not
awaited. Listener replacement remains safe when callbacks are reused, and sink
diagnostics cannot interrupt dispatch.
