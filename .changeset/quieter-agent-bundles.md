---
"@pracht/core": patch
"@pracht/vite-plugin": patch
---

Keep graph-only MCP and capability metadata separate from lazy request transports so server builds no longer report ineffective dynamic imports, and explicitly classify Rolldown's tree-shaken `node:module` helper in edge builds while failing the build if any Node builtin import actually survives. Application route registration also no longer narrows framework-internal navigation implementations, allowing generated route declarations to typecheck against source workspaces.
