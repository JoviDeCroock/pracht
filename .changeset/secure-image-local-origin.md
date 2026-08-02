---
"@pracht/image": patch
---

Require an explicit trusted `localOrigin` for relative image optimization sources so forged loopback or metadata-service Host headers cannot trigger server-side requests.
