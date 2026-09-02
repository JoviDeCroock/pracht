---
"@pracht/core": minor
---

Add `serverOnly()` and `<StaticHtml>` for loader fields the SSR document should not carry twice.

A loader can mark a field with `serverOnly(value)` when its only job was to
become the markup on the page. The field is replaced with a placeholder in the
inline hydration state and rendered through `<StaticHtml>`, which adopts the
server-rendered subtree instead of hydrating it. Route-state responses — what a
client-side navigation fetches — still carry the real value, so no request
moves and nothing gets slower. A route that does not call `serverOnly()` is
unchanged.

The boundary never hydrates, so it suits markup that is finished on the server — compiled Markdown, a rendered diff — and not markup that embeds interactive components.
