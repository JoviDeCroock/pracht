---
"@pracht/core": patch
"@pracht/adapter-cloudflare": patch
---

Limit `Vary: Accept` to routes that export a Markdown representation while applying it to both their HTML and Markdown responses. Cloudflare Workers Caching no longer fragments every ISG route by verbatim browser `Accept` strings, and its path, query-string, trailing-slash, and remaining Markdown variant behavior is now documented with bounded-query and gateway-normalization guidance.
