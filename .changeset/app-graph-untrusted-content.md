---
"@pracht/capabilities": patch
"@pracht/core": patch
"@pracht/cli": patch
---

App-graph capability entries (`pracht inspect capabilities --json`, `/_pracht`) now carry `webmcpUntrustedContent` when a WebMCP tool sets `untrustedContent`, and a committed `.pracht/app-graph.json` stays current across the upgrade.
