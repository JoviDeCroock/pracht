---
"@pracht/core": patch
---

Stop the client router from undoing in-page fragment scrolls, and move focus to fragment targets.

Clicking `<a href="#section">` fires `popstate` for a brand new history entry rather than a
traversal. The router read every `popstate` as a traversal and restored the saved scroll position,
which scrolled the page straight back from the fragment the browser had just jumped to — so in-page
anchors and skip links appeared not to work at all.

The router now tells the two apart by the scroll key it stamps into `history.state` for every entry
it creates: a keyless entry whose path and query are unchanged is a fragment navigation, so the
browser's own jump is left to stand. A traversal onto an entry with no saved position now falls back
to the URL's fragment instead of hard-resetting to the top.

Wherever the router scrolls to a fragment itself, it now also moves focus to the target — adding a
temporary `tabindex="-1"` for elements that are not natively focusable and removing it again on blur.
Without this a skip link scrolled but left the next Tab stop at the top of the page, which defeats
the purpose of the link. `scrollIntoView()` is still called with no `behavior` option, so a CSS
`prefers-reduced-motion` rule can turn a smooth scroll off.
