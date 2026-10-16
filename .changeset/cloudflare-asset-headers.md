---
"@pracht/cli": minor
---

`pracht build` for Cloudflare writes `dist/client/_headers`, so content-hashed `/assets/*` files are cached as immutable and keep Pracht's security headers, including when `run_worker_first` excludes them from the Worker.
