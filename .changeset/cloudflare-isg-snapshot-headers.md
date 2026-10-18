---
"@pracht/adapter-cloudflare": patch
---

A Cloudflare ISG page regenerated at runtime is served with the headers its own render produced, so `headers()` values computed from loader data, such as `x-robots-tag`, no longer revert to their build-time values.
