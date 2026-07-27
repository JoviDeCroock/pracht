---
"@pracht/core": patch
---

Fix a repeat click on an in-page fragment link doing nothing.

Fragment links were left to the browser, which works once: the browser pushes an
entry with no scroll key, and the router recognizes the `popstate` that follows
as a fragment navigation rather than a traversal — but stamps a scroll key onto
that entry in the process. Clicking the same link again reuses the entry, so the
key is now there, the `popstate` reads as a back/forward traversal, and the
position saved for the entry (the top of the page, where the user had scrolled
back to) is faithfully restored. The click was dead.

The client router now commits fragment link clicks itself — pushing the history
entry, scrolling to the target, and moving focus there — so a repeat click always
scrolls, and `popstate` is left to mean "traversal", which is what the
scroll-key logic assumes. `hashchange` is dispatched for the intercepted
navigation, since `pushState` fires none. The `popstate` guard stays as the
fallback for fragment entries created another way (`location.hash = "…"`).
