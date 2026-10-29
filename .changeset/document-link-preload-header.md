---
"@pracht/core": minor
---

Server-rendered and prerendered pages now send a `Link` header listing their stylesheets and font preloads, so CDNs with Early Hints (such as Cloudflare) can start those downloads before the HTML arrives.
