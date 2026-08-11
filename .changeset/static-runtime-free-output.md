---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
"@pracht/adapter-static": minor
"create-pracht": minor
---

Add a runtime-free static deployment target for SSG, SPA, islands, and
no-hydration routes.

- `@pracht/adapter-static` emits Netlify/Cloudflare Pages rules, a functionless
  Vercel Build Output API directory, or a generic host manifest.
- SSG loader data is captured into collision-free static route-state snapshots
  so full-hydration client navigation stays client-side without a function.
- SPA shell documents, dynamic SPA fallbacks, the app `404.html`, safe document
  headers, immutable asset caching, and production-faithful `pracht preview`
  behavior are generated together.
- Static builds fail closed on SSR, ISG, API routes, and dynamic SPA behavior
  that would require a request-time runtime.
- `create-pracht --adapter=static` scaffolds an immediately buildable static
  app, omitting the sample API route and defaulting to generic host rules.
- Vercel's runtime-backed output now applies baseline and per-document headers
  through continuing route entries, which the Build Output API actually honors.
