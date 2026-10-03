---
"@pracht/vite-plugin": patch
---

Routes with `hydration: "none"` or `"islands"` now ship their own stylesheets on Cloudflare and Vercel, where production builds previously linked only the shell's CSS.
