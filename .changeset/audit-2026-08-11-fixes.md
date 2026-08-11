---
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-vercel": patch
"@pracht/adapter-node": patch
"create-pracht": patch
"@pracht/core": minor
"@pracht/cli": minor
---

Close the findings of the 2026-08-11 framework permutation audit.

**Vercel ISG webhook revalidation could never authenticate.** The adapter read
`PRACHT_REVALIDATE_TOKEN` through a `globalThis.process.env` alias; the package
bundler inlined that single-use alias, and the *app* build's `process.env`
define then collapsed it to `return {}[PRACHT_REVALIDATE_TOKEN_ENV]`. Every
`POST /__pracht/revalidate` answered `401` regardless of configuration, on both
the Edge render function and the Node ISG launcher. The read now goes through
`serverEnv` via a new `resolveRevalidationToken()` in `@pracht/core`, which all
three adapters share, and the Vercel build E2E asserts both the absence of
collapsed env reads in the emitted bundle and a working authenticated request —
unit tests against `src/` could not catch a defect the build introduced.

**A uniform default `Cache-Control` across adapters.** `preventHeuristicCaching`
moved from `@pracht/adapter-cloudflare` into `@pracht/core` and now runs on Node
and Vercel too, so `GET`/`HEAD` responses with no caching policy get
`private, no-cache` on every adapter. A shared cache in front of the origin may
otherwise apply heuristic freshness to an authenticated SSR page, and `Cookie` is
not part of its cache key. Previously an app hardened on Cloudflare lost the
protection when it moved to Node or Vercel. Any CDN-targeted policy the app sets
itself — including the vendor-neutral `CDN-Cache-Control` — suppresses the
default, and ISG document responses are exempt on every adapter so a route's
caching headers do not depend on whether its snapshot exists yet.

**A Web Bot Auth signer.** `@pracht/core/agent-auth` is a new entry point
exporting `signAgentRequest()`, `createAgentSignatureHeaders()`, and
`generateAgentKeyPair()` — the RFC 9421 signing side the framework verified but
never shipped. `pracht eval` scenarios gain a `signAs` block (and per-step
`"sign": false`), so a capability declaring `agentPolicy: "require"` is finally
reachable from the framework's own agent-task harness rather than only from
Playwright.

**Revalidation webhooks explain themselves.** `POST /__pracht/revalidate` adds a
`details` array naming why each path was skipped (`not_a_route`, `not_isg`,
`not_prerendered`, `no_webhook_policy`) or failed. The three existing path
arrays are unchanged. All three adapters now build the response through one
shared `RevalidationReport`.

**llms.txt no longer advertises framework plumbing.** Paths containing a
`_pracht` or `__pracht` segment — such as the `@pracht/image` endpoint at
`/api/_pracht/image` — are excluded from the generated index by default. A build
that would overwrite a hand-authored `public/llms.txt` now warns instead of
discarding it silently, and `pracht llms` gains `--out` plus a note about the
two unrelated documents that share the name.

**Verification and scaffolding.** `pracht verify` warns when a Cloudflare app's
assets binding leaves `html_handling` at a default that 307-redirects every
prerendered route, and reports when no `.pracht/app-graph.json` snapshot exists
rather than staying silent. `create-pracht` points `.mcp.json` at the project's
own CLI (`npx --no-install pracht mcp`) instead of the registry's latest, names
the pages router's manifest-only tradeoffs at the router prompt, and documents
in `--help` that `--template` and `--tailwind` set the same thing (last one
wins).
