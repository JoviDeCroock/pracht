---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
---

Make agent traffic observable: composable audit sinks, a dev Agents panel, and `pracht inspect agents`.

Named audit listeners now compose safely with existing hooks and dev HMR. In
development, `/_pracht` records recent capability dispatches, while the new CLI
and MCP inspection commands summarize agent policies, transports, and discovery.
