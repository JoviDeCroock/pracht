---
"@pracht/core": patch
---

Server-rendered documents use less CPU per request, because the HTML is encoded to bytes once instead of being re-validated and re-encoded as a string body.
