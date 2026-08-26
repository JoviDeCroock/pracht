---
"@pracht/core": patch
---

Fail builds when every attempted SSG/ISG page returns a non-200 response instead of shipping empty prerender output.

Serverful builds still warn and skip individual failures when at least one page prerenders successfully; static exports remain fail-fast.
