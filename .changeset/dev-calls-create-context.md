---
"@pracht/vite-plugin": patch
"@pracht/adapter-node": patch
"@pracht/adapter-vercel": patch
"@pracht/adapter-netlify": patch
---

`pracht dev` now builds `args.context` with the adapter's `createContextFrom` factory, so loaders, middleware, and API routes see the same context in development as in production.
