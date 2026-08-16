---
"@pracht/cli": patch
---

Stop publishing framework metadata into a static export's deploy directory.

`pracht build` wrote `_pracht/headers.json` and `_pracht/markdown.json` into `dist/client/` for every adapter. Only the Cloudflare worker reads them from there — it fetches both through its assets binding — while node, netlify, and vercel read the `dist/server/*-manifest.json` copies. A static export has no runtime at all, so for `@pracht/adapter-static` those files were permanently dead bytes in the one directory users upload, and `headers.json` published the app's full route list with each route's header policy.

Static exports now skip both. `dist/server/headers-manifest.json` and `dist/server/markdown-manifest.json` are still written, and remain the reference for mirroring headers into a host's own configuration — the docs and the `pre-deploy` skill now point there. This matches the rule `_pracht/isg.json` already followed: framework metadata only reaches the public client directory when a runtime actually reads it from there.

`_pracht/env-safety.json` is deliberately kept: `pracht verify` reads it from that exact path, and on a successful build it is always an empty findings report (the plugin fails the build otherwise). Cloudflare, node, netlify, and vercel output is unchanged.
