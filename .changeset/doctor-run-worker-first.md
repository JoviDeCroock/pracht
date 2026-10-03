---
"@pracht/cli": patch
---

`pracht doctor` now warns when a Cloudflare app's `wrangler.jsonc` omits `assets.run_worker_first`, which leaves prerendered pages without ISG, Markdown negotiation, and route headers.
