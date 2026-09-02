---
"@pracht/session": minor
---

Add `@pracht/session`: encrypted cookie sessions or store-backed session ids, secret rotation, flash values, `sessionMiddleware()`/`requireSession()`, and WebCrypto password hashing. The session cookie is named `__Host-session` by default, which pins it to `Secure`, `Path=/`, and host-only; pass an unprefixed `cookie.name` if it has to be shared across subdomains.
