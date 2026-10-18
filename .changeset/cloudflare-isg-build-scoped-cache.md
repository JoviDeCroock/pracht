---
"@pracht/adapter-cloudflare": patch
---

After a deploy, Cloudflare ISG pages are served from the new build instead of HTML the previous build cached against its deleted assets. The first deploy after upgrading starts each data center's ISG cache cold, costing one cache miss per page.
