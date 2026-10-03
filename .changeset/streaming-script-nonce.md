---
"@pracht/core": minor
---

Return `scriptNonce` from `head()` to put a CSP nonce on every inline script a `streaming: true` route emits, including the speculation rules script, so deferred boundaries resolve under a nonce-based `script-src`.
