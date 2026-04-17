---
"@pracht/core": minor
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-node": patch
---

Add Markdown-for-Agents content negotiation.

Route modules can now export a `markdown: string` alongside their `Component`.
When a request arrives with `Accept: text/markdown` (or markdown ranked above
`text/html` via q-values), the runtime returns the raw markdown source with
`Content-Type: text/markdown; charset=utf-8` and `Vary: Accept`, bypassing
the component render pipeline.

The Cloudflare and Node adapters skip static-asset serving for these
requests so SSG routes fall through to the framework, where the markdown
source is read from the route module instead of the prerendered HTML.
