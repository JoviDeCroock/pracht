---
"@pracht/content": minor
"@pracht/cli": patch
---

Add the opt-in, server-only `@pracht/content` collection primitive. One
canonical registry now provides source discovery or explicit route/source
mapping, locale-aware fallback, raw/frontmatter/body/compiled representations,
per-source memoization, deterministic build iteration, loader and Markdown
helpers, and validated static asset generation. Its Vite integration reuses the
same registry for route-module transforms, watcher invalidation, live dev
assets, and client build output.

Curated `llms.txt`/`llms-full.txt`, raw-source assets, and app-owned
page/basic-search capability fields are opt-in helpers rather than core
framework policy. The docs application now proves the integration by compiling its
Markdown routes and generating both LLM artifacts from the collection; the old
second filesystem/manifest reader has been removed. `pracht verify` recognizes
`@pracht/content` as a Markdown transform integration.

Explicit registries now leave unregistered Markdown sources available to other
Vite plugins, locale-neutral id lookups retain the configured default locale,
and development artifact failures no longer block unrelated Vite or application
requests. Verification only treats the `@pracht/content/vite` integration as a
registered Markdown transform.

Follow-up hardening adds cached registry indexes, root-relative invalidation,
root-prefix `llms.txt` sections, whitespace-stable search snippets, and
production artifact content-type metadata. Request-time loaders and
capabilities now use `virtual:pracht/content/<name>`, a JSON-validated,
filesystem-free snapshot that runs across Node, Vercel, and Cloudflare.
