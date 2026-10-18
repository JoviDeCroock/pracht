---
"@pracht/adapter-node": patch
---

The Node server now answers byte-range requests for static files with `206`, so Safari can play `<video>` from it, and serves `.mjs`, `.map`, `.avif`, `.mp4`, `.webm`, `.vtt`, `.mp3`, `.ogg`, `.wav`, `.pdf`, `.csv`, and `.zip` files with their real content types.
