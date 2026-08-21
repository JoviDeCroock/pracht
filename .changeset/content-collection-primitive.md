---
"@pracht/content": minor
"@pracht/core": patch
"@pracht/cli": patch
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-netlify": patch
"@pracht/adapter-node": patch
"@pracht/image": minor
"@pracht/markdown": minor
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
second filesystem/manifest reader has been removed.

Explicit registries now leave unregistered Markdown sources available to other
Vite plugins, locale-neutral id lookups retain the configured default locale,
`routePrefix: "never"` collections allow translations to share one route, and
development artifact failures no longer block unrelated Vite or application
requests.

Add `@pracht/markdown`, the official collection compiler for Markdown route
modules, together with cached `?pracht&pracht-static` responsive WebP variants
and reusable plain image props in `@pracht/image`. Relative Markdown images are
resolved as sibling Vite imports and rendered as hydration-free `<img>` markup;
SVG and animated originals retain their encoded format, and server-only graph
assets are published to the client output, including root-level Vite asset
directories.

Harden the complete authoring and deployment path: cache registry indexes,
invalidate changed, added, and removed sources through lexical or symbolic
collection roots, and preserve prototype-named data in JSON-validated,
filesystem-free runtime snapshots. Locale fallback remains explicit for the
default locale, malformed capability lookups fail closed, and empty YAML
frontmatter is accepted.

Generated artifacts now carry content types across Node, Cloudflare, Netlify,
and Vercel through adapter-native routing; preserve Vite resource-query imports;
and reject collisions with public files, generated bundle output, prerendered
pages, exact request-time page or API paths, clean-URL `index.html` aliases,
concrete ISG paths served by adapter functions, core `llms.txt`, OpenAPI output,
other case-folded or parent/child artifacts, Pracht's `/_pracht` namespace, and
Netlify's root `/_headers` and `/_redirects` control files, including descendants
that would turn those required files into directories. Artifact filenames must
be portable and canonical, while Vercel header routes escape literal artifact
path syntax. Netlify also applies exact generated headers to bypassed static
paths and rejects manifest entries that would become wildcard rules.
Locale fallback records ignore prototype-inherited keys, and Markdown image
markers remain stable when identical projects are built from different checkout
paths. Locale fallback targets are validated before collection snapshots are
emitted; record keys must also name supported requested locales. Explicit routes
cannot silently shadow generated locale aliases. Content search ignores locale
hints for unlocalized collections while advertising supported locales for
localized ones. Artifact content types are validated before entering response or
deployment headers, and generated headers remain intact on clean URL aliases for
artifact `index.html` files.
Loader lookups use Pracht's matched base-free pathname, development artifacts
honor Vite's configured deployment base, locale alias collisions include the
target locale, and artifact content types must parse as portable HTTP media types
that can be represented by Web response headers.
Artifacts inside an `/assets/` path override adapter-wide immutable caching with
a revalidation policy because their filenames are not required to contain a
content hash.

Unprocessed `publicDir` static image imports now bypass configured runtime
loaders, and Markdown preserves custom Marked image renderers for root-relative,
remote, and data image sources. Netlify builds preserve hand-authored `_headers`
files copied from a custom Vite public directory.
