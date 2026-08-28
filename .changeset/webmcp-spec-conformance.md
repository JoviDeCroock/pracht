---
"@pracht/vite-plugin": minor
"@pracht/capabilities": minor
"@pracht/cli": minor
---

Align the WebMCP projection with the current spec and its shipping hosts (ChatGPT desktop browser, Chrome/Edge origin trial).

Page tools now resolve `execute()` to the capability envelope as a plain value — the host serializes it per the spec — instead of MCP-style content blocks, which reached agents double-encoded. Descriptors gain the capability `title`, the remote MCP projection's effect-derived hint set (`readOnlyHint`/`destructiveHint`/`idempotentHint`), and, via the new `expose.webmcp: { untrustedContent: true }` options form, the `untrustedContentHint` annotation. The shim targets `document.modelContext` only: the getter landed in Chromium 150 and the deprecated `navigator.modelContext` alias was removed in 152, so pre-150 origin-trial builds are no longer targeted. Names outside the WebMCP tool-name grammar are rejected at registry resolution and by `pracht verify`, which also warns when a page tool sits behind an effective `agentPolicy: "require"` (unsigned page fetches always 401) and when tool or parameter descriptions exceed the published agent-legibility budgets. Type note: the exported `CapabilityExposure` and `CapabilityProjection` shapes gained required `webmcpUntrustedContent` (and `title` on the projection) fields — code constructing these objects by hand needs the new fields.
