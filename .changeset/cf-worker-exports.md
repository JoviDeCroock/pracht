---
"@pracht/adapter-cloudflare": minor
---

Add `durableObjectsDir` and `workflowsDir` options to `cloudflareAdapter()` — files in these directories are automatically re-exported from the generated worker entry so Cloudflare discovers DurableObject and Workflow classes.
