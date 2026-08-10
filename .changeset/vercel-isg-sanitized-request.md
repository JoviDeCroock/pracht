---
"@pracht/adapter-vercel": patch
"@pracht/adapter-cloudflare": patch
"@pracht/core": patch
---

Render Vercel and Cloudflare Workers Caching ISG routes on a sanitized request so a cache miss cannot store a personalized page.

Vercel's prerender functions were invoked with a faithful copy of the visitor's
request, so loaders saw that visitor's `Cookie` and `Authorization` headers while
producing HTML that Vercel stores in the ISR cache (keyed on the path alone) and
replays to everyone else. `createVercelNodeListener` now renders on the same
sanitized ISG request the Node and Cloudflare regeneration paths use — `GET`,
`Accept: text/html`, path only, no query string or body — and strips credential
headers (`Set-Cookie`, `Authorization`, `WWW-Authenticate`, `Proxy-Authenticate`,
secret-shaped `x-*`) from the response before Vercel caches it, matching what
build-time prerendering already refuses to emit. Responses that mark themselves
uncacheable are logged, since Vercel's prerender cache stores them regardless.

Cloudflare Workers Caching cold and stale renders now use the same sanitized
request as the worker-managed Cache API regeneration path before calling
`createContext`, middleware, or loaders. Query strings still participate in the
edge cache key, but they cannot influence the shared response that application
code renders; markdown-capable routes retain a canonical `text/markdown`
variant without forwarding the visitor's raw `Accept` value.

`createISGRegenerationRequest(pathname, base)` now accepts a `URL` or absolute
URL string as its base in addition to a `Request`, and `@pracht/core` exports
`isDangerousPrerenderHeader` plus the server-side `prefersMarkdown` negotiation
helper for adapters that write into a shared cache.
