---
"@pracht/adapter-node": patch
---

Abort the request signal when the client hangs up before the response finished, so loaders, middleware, and API handlers see the disconnect. The Cloudflare, Netlify, and Vercel adapters already pass the platform request through and needed no change.
