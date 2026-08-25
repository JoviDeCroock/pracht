---
"create-pracht": patch
---

Add five skills to the seeded catalog: `/add-content`, `/add-images`,
`/add-capabilities`, `/add-openapi`, and `/audit-agent-surface`.

`@pracht/content`, `@pracht/markdown`, `@pracht/image`, `@pracht/capabilities`,
and `@pracht/openapi` shipped without a skill, so an agent wiring any of them
had to rediscover the plugin order, the server-only snapshot boundary, the
loader-per-target matrix, the inline-literal constraint on `expose`/`effect`,
and the destructive confirmation gate from the docs each time.
`/audit-agent-surface` reports what agents can actually reach — capability
exposure, `agents` trust config, `llms.txt`, Markdown negotiation, OpenAPI —
and confirms an app that wants no agent surface pays nothing for one.
