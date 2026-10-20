---
"@pracht/cli": patch
---

Cloudflare builds now write prerendered pages with percent-encoded paths (`/posts/caf%C3%A9`) where the assets binding finds them, so those ISG pages cache by time instead of rendering on every request.
