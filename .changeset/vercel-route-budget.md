---
"@pracht/cli": patch
---

Vercel builds share header, Markdown and trailing-slash routes across pages, so each prerendered page costs one route against Vercel's 2,048-route deployment limit, and `pracht build` warns as a build nears it.
