---
"@pracht/core": minor
---

Speculation rules now exclude individual links. Every emitted rule carries a
`not: { selector_matches }` clause covering `rel="nofollow"` anchors and the new
cascading `data-pracht-speculate` attribute — set `"off"` on any element to opt
its subtree out, `"on"` to re-enable part of it. `<Link speculate={false}>`
renders the attribute for typed links.

Excluded anchors keep the ordinary SPA path: the JS `prefetch` strategy still
applies to them, and the client router intercepts their clicks rather than
waiting for a prerendered document that will never exist. Browser and client
matching stay aligned for case-insensitive `nofollow` tokens and reactive
changes to exclusion attributes.
