---
"@pracht/session": minor
---

Add `@pracht/session`: encrypted cookie sessions or store-backed session ids, secret rotation, flash values, `sessionMiddleware()`/`requireSession()`, and WebCrypto password hashing. It uses `crypto.subtle` only, so the same build runs on Node, Cloudflare Workers, Netlify, and Vercel.
