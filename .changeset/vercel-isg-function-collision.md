---
"@pracht/cli": patch
---

Fail Vercel builds with a clear error when an ISG route's prerender function
name collides with the main edge function directory, preventing the main
function from being silently converted into a prerender function.
