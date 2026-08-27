---
"@pracht/vite-plugin": minor
"@pracht/capabilities": minor
"@pracht/cli": minor
---

Align the WebMCP projection with the current spec and its shipping hosts (ChatGPT desktop browser, Chrome/Edge origin trial).

Page tools now resolve `execute()` to the capability envelope as a plain value — the host serializes it per the spec — instead of MCP-style content blocks, which reached agents double-encoded. Descriptors gain the capability `title` and, via the new `expose.webmcp: { untrustedContent: true }` options form, the `untrustedContentHint` annotation. The shim targets `document.modelContext` only: Chromium removed the deprecated `navigator.modelContext` alias in 152, and current polyfills install the `document` shape. `pracht verify` now rejects tool names outside the spec grammar, warns when a page tool sits behind an effective `agentPolicy: "require"` (unsigned page fetches always 401), and warns when tool or parameter descriptions exceed the published agent-legibility budgets.
