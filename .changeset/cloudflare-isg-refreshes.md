---
"@pracht/adapter-cloudflare": patch
---

ISG pages on Cloudflare now refresh after their revalidation window or a `/__pracht/revalidate` webhook instead of serving the build-time copy forever.
