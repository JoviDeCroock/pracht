---
"create-pracht": patch
---

The seeded `/add-auth` and `/audit-redirects` skills now gate login redirect targets with a same-origin URL check, so a target such as `/\evil.com` no longer escapes to another site.
