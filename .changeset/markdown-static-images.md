---
"@pracht/image": minor
"@pracht/markdown": minor
---

Add cached build-time responsive WebP variants, reusable plain image props,
and an official Markdown collection compiler that optimizes relative images
without adding client runtime JavaScript.

Bare relative Markdown image paths such as `![Alt](photo.jpg)` are anchored to
`./` so Vite resolves the sibling file instead of failing on a bare package
specifier. Compiled image markup is substituted with a replacer function, so
`$&`-style sequences in author-written alt and title text survive verbatim, and
the substitution now runs once at module evaluation rather than on every
render.
