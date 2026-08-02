---
"@pracht/vite-plugin": patch
---

Prevent flashes of unstyled content in development by linking each matched route and shell's transitive Vite CSS dependencies in the initial HTML, including for adapter-owned dev servers such as Cloudflare.
