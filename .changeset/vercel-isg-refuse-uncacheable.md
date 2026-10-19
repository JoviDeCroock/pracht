---
"@pracht/adapter-vercel": patch
---

An ISG render that sets a cookie or marks itself private is no longer stored in Vercel's prerender cache: the function answers `503` and visitors keep the previous page.
