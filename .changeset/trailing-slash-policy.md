---
"@pracht/vite-plugin": minor
"@pracht/core": minor
"@pracht/cli": minor
"@pracht/adapter-node": minor
"@pracht/adapter-cloudflare": minor
"@pracht/adapter-netlify": minor
"@pracht/adapter-static": minor
---

`pracht({ trailingSlash: "always" | "never" })` makes `/about/` or `/about` the one canonical page URL: links, redirects, and `llms.txt` use it on every adapter, and the other spelling answers with a 308.
