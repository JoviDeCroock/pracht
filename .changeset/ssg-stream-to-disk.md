---
"@pracht/core": minor
"@pracht/cli": patch
"@pracht/adapter-node": patch
"@pracht/adapter-netlify": patch
"@pracht/adapter-cloudflare": patch
---

`pracht build` writes each prerendered page as soon as it renders and starts the next one without waiting for a batch, so build memory no longer grows with the site's total HTML, and Node, Netlify and Cloudflare builds store each distinct set of page headers once in `headers-manifest.json`.
