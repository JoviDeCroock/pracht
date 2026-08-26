---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
---

Make agent traffic observable: composable audit sinks, a dev Agents panel, and `pracht inspect agents`.

`addCapabilityAuditListener(name, hook)` registers an audit sink alongside any
existing one and returns an unsubscribe handle — `setCapabilityAuditHook()`
stays a single slot and both fire. Re-registering the same name replaces that
sink, so a module-scope registration stays safe under dev HMR. A throwing sink
is still swallowed, and its first failure is now reported once per sink.
Subscription changes made during delivery apply to the next event.

In dev, `/_pracht` gains an **Agents** section showing recent capability
dispatches (transport, `via`, effect, verified agent, outcome, duration), with
every recorded event under `agentTraffic` in `/_pracht.json`; it lives in the
dev middleware, so nothing ships to production. `pracht inspect agents [--json]`
(and the `inspect_agents` MCP tool) summarizes the configured surface: Web Bot
Auth policy and keys, confirmation mode, remote MCP endpoint, `llms.txt`, and
per-transport exposure counts. Inspection reads the resolved `llmsTxt` option,
and the panel avoids classifying traffic that has already left its retained
window.
