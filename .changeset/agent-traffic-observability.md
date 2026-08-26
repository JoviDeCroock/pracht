---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
---

Make agent traffic observable: composable audit sinks, a dev Agents panel, and `pracht inspect agents`.

`addCapabilityAuditListener(hook)` registers an audit sink without displacing an
existing one and returns an unsubscribe handle — `setCapabilityAuditHook()`
stays a single slot and both fire. In dev, `/_pracht` gains an **Agents**
section showing the last 200 capability dispatches (transport, `via`, effect,
verified agent, outcome, duration), with the same data under `agentTraffic` in
`/_pracht.json`; it lives in the dev middleware, so nothing ships to
production. `pracht inspect agents [--json]` (and the `inspect_agents` MCP tool)
summarizes the configured surface: Web Bot Auth policy and keys, confirmation
mode, remote MCP endpoint, `llms.txt`, and per-transport exposure counts.
