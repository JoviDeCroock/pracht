# Framework permutation audit (deployment adapters) — 2026-08-11

## Purpose

A companion to
[`FRAMEWORK_PERMUTATION_AUDIT_2026-08-11.md`](FRAMEWORK_PERMUTATION_AUDIT_2026-08-11.md),
which covers render × hydration cross-products and the pages router. This pass
runs the same question through the three deployment adapters instead: a
full-surface dogfood of Pracht as both a human-facing and an agent-facing
framework, run against the tree that landed all twelve findings of the
[2026-08-10 audit](FRAMEWORK_PERMUTATION_AUDIT_2026-08-10.md). Every deployment
adapter was exercised on both surfaces; scaffolding, both routers, all render and
hydration modes, capabilities, remote MCP, Web Bot Auth, destructive confirmation,
ISG revalidation, and the CLI were driven end to end.

Goals, unchanged from the previous pass:

- gaps between runtime behavior and `docs/` / `examples/docs`;
- problems or confusing edges in the public API;
- adoption footguns in scaffolding, local development, and deployment;
- runtime and tooling bugs.

This is an evidence report. Nothing in the workspace was changed to make a finding
go away; the only repository writes were this file and temporary artifacts that
were reverted (see [Reproduction notes](#reproduction-notes)).

## Test baseline

- Commit: `f840b1f` (`origin/main`, "Merge pull request #290")
- Node.js: `v22.22.3`
- Repository package manager: pnpm `11.3.0`
- Generated-project toolchain: published `@pracht/*`, TypeScript `7.0.2`, Vite `8.2.1`
- Host: macOS, local execution only

No external Cloudflare or Vercel deployments were created. Cloudflare ran in the
real local Workers runtime (`wrangler dev` against the built worker). Vercel was
exercised by importing its Build Output API artifacts and invoking the generated
handlers directly. The live documentation site was read over the public network
but not modified.

## Coverage

### Deployment and interaction matrix

| Adapter/workflow | Human surface | Agentic surface | Result |
| --- | --- | --- | --- |
| Node production server | SSR, SSG, ISG, SPA redirect, islands, API, auth middleware, route-state, markdown negotiation, 404 | llms.txt, capability HTTP, remote MCP, signed Web Bot Auth, prepare/commit, `pracht eval` | Passed |
| Cloudflare Workers (workerd) | same probe set in the real runtime | same agentic probe set + `pracht eval` | Passed, with a trailing-slash divergence ([F-02](#f-02)) |
| Vercel Build Output v3 | SSR, SSG, ISG, SPA redirect, API, auth middleware, route-state, markdown, 404 via the exported edge handler | llms.txt (static), capability HTTP, remote MCP, signed Web Bot Auth, prepare/commit | Passed except ISG webhook revalidation ([F-01](#f-01)) |
| `pracht dev` (Node) | full route/API/banner surface, devtools at `/_pracht` | live llms.txt, capability HTTP, MCP, signed Web Bot Auth | Passed |
| Showcase workflow | operator approval UI, admin API | two eval scenarios incl. human-approval gate | Passed |

Node probes covered `/`, `/notes`, `/products/:id` (enumerated and un-enumerated),
`/pricing`, `/gallery`, `/settings`, `/dashboard` (with and without session),
a missing route, static assets, both route-state forms, `Accept: text/markdown`,
`/llms.txt`, `/mcp`, all five capabilities, the destructive prepare/commit flow
(including token replay and input-mismatch rejection), and
`POST /__pracht/revalidate` (valid token, wrong token, unknown path, non-ISG
route, oversized batch). Cloudflare and Vercel repeated the same set.

### Render and hydration modes

`examples/islands` was built for all three adapters (Node, Cloudflare, Vercel) and
the prerendered output compared byte-for-byte across targets. `hydration: "none"`
emits zero `<script>` tags and zero modulepreloads on every adapter; `islands`
routes emit one bootstrap; `full` emits two. Output was identical across targets.

### Scaffold matrix

All 24 `create-pracht` combinations (adapter × router × template × agent tools)
completed a dry run. Six representative projects were installed and built with
pnpm 11 against the **published** packages:

| Project | Adapter | Router | Template | Agent tools | install | build | `tsc --noEmit` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| n1 | node | manifest | minimal | yes | ok | ok | ok |
| cf1 | cf | manifest | minimal | yes | ok | ok | ok |
| v1 | vercel | manifest | minimal | yes | ok | ok | ok |
| np1 | node | pages | tailwind | no | ok | ok | ok |
| cfp1 | cf | pages | minimal | no | ok | ok | ok |
| vp1 | vercel | pages | tailwind | no | ok | ok | ok |

The pnpm 11 `ERR_PNPM_IGNORED_BUILDS` blocker from the previous audit (F-04) is
resolved: every project installed cleanly on the default happy path.

### Repository checks

- `pnpm run build`: passed.
- `CI=1 pnpm run verify --skip-build`: passed (format, lint, generated types,
  generated typecheck, workspace typecheck, unit tests, Playwright E2E), 67.3s.
- `examples/showcase` `verify` and both eval scenarios: passed.
- `examples/tsrx`, `examples/docs`, `examples/pages-router` graph commands and
  builds: passed.

## Remediation

All findings were worked through after the audit. The findings below are kept in
the present tense as observed at the baseline commit, so the original symptom and
reproduction survive; this table records what actually changed.

Two findings did not survive verification and are corrected rather than "fixed" —
recorded here because a wrong finding is worse than no finding.

| Finding | Status | Remediation |
| --- | --- | --- |
| [F-01](#f-01) | Fixed | Token read moved to `resolveRevalidationToken()` in `@pracht/core`, shared by all three adapters. The Vercel build E2E now asserts the emitted bundle contains no collapsed env reads *and* drives the built handler's revalidate endpoint with and without the token. |
| [F-02](#f-02) | Fixed | `html_handling: "drop-trailing-slash"` added to the three example configs; `pracht verify` warns when a Cloudflare app with prerendered routes leaves it unset. |
| [F-03](#f-03) | Fixed | `_pracht`/`__pracht` paths are excluded from llms.txt by default; `examples/basic` excludes its two auth-gated pages. |
| [F-04](#f-04) | Fixed | Pages-router limitation table published on the public routing page, cross-linked from the capabilities and agent-trust pages, and named at the `create-pracht` router prompt. |
| [F-05](#f-05) | Fixed | `product.tsx` throws `notFound()`; `/products/99` answers `404` with the app's not-found page on all three adapters. |
| [F-06](#f-06) | Fixed | The 11 `lead:` fields are Markdown; the docs-site renderer converts code spans to `<code>` for HTML, and a test rejects HTML in `lead:`. |
| [F-07](#f-07) | Fixed | New `@pracht/core/agent-auth` entry point (`signAgentRequest`, `createAgentSignatureHeaders`, `generateAgentKeyPair`) and a `signAs` block for `pracht eval`. `examples/basic/evals/agent-identity.eval.json` now covers both halves of `agentPolicy: "require"`. |
| [F-08](#f-08) | Fixed | `preventHeuristicCaching` moved from the Cloudflare adapter into `@pracht/core` and is applied by Node and Vercel too; `docs/ADAPTERS.md` gained a shared section. |
| [F-09](#f-09) | Fixed | `POST /__pracht/revalidate` gained a `details` array with per-path reasons, built through one shared `RevalidationReport`. `/pricing` in the example now opts into `webhookRevalidate()`. |
| [F-10](#f-10) | Fixed | The build warns before overwriting a hand-authored `public/llms.txt`; `pracht llms` gained `--out` and a note distinguishing the two documents. |
| [F-11](#f-11) | **Withdrawn** | Not reproducible on `main`. Both git call sites already silence stderr; the leak only occurs with the *published* `@pracht/cli@1.9.0`, which the audit invoked via `pnpm exec`. This is an instance of [F-15](#f-15), not a separate defect. |
| [F-12](#f-12) | Fixed | `pracht verify` reports when no `.pracht/app-graph.json` exists instead of staying silent. |
| [F-13](#f-13) | Partly withdrawn | The `.mcp.json` version-skew was real and is fixed (`npx --no-install pracht mcp`). The Dockerfile claim was **wrong** — it is already package-manager aware; the audit saw npm because it invoked the CLI without a package-manager user agent. The unconditional `pnpm-workspace.yaml` is **deliberate**, covered by a named test, and was left alone. |
| [F-14](#f-14) | Partly fixed | `--no-budget-fail` help text corrected; `--tailwind` precedence documented in `--help`. The precedence itself is deliberate and tested, so it was documented rather than changed. |
| [F-15](#f-15) | Unchanged | Release hygiene; resolved by publishing. |

Two behaviours were reviewed and deliberately **not** changed, because each is
covered by a test that names the intent: `create-pracht` writing an inert
`pnpm-workspace.yaml` for npm/yarn/bun scaffolds (so a later `pnpm install` still
has a build-script policy), and `--tailwind`/`--no-tailwind` taking precedence
over `--template`. Both were changed during remediation and then reverted when
those tests failed — the tests were right.

### Adversarial review of the remediation

Two independent review scopes — runtime/security, and docs/behaviour
justification — were run against the remediation diff and found real defects in
it. Everything below was introduced by the fixes above, not by the baseline:

- **The Vercel `Cache-Control` default poisoned the ISG prerender cache.** The
  generated entry wires `nodeListener = createVercelNodeListener(handle)` around
  the very handler the stamp was added to, so every ISG regeneration was written
  into Vercel's prerender cache as `private, no-cache` — and, because
  `isCacheableISGResponse` rejects `private`, fired a "render this route as SSR
  instead" warning the framework itself had caused. ISG responses are now exempt
  on every adapter, with a regression test that fails when the guard is removed.
- **Node ISG cold and warm hits disagreed** for the same reason: the cold render
  was stamped while the on-disk hit kept `public, max-age=0, must-revalidate`.
- **The Vercel webhook started acting where it used to skip.** `render` is
  optional on a resolved route, and `entry.render !== undefined && … !== "isg"`
  treated `undefined` as "proceed". Now a strict `!== "isg"`.
- **Two false statements in the remediation's own docs.** The changeset claimed
  scaffold behaviour that had been reverted, and the new `--help` line asserted
  a `--tailwind` precedence that does not exist (the real rule is last-flag-wins,
  measured). Both corrected.
- **`signAgentRequest` did not leave the original request usable.**
  `new Request(request)` disturbs the source body per the Fetch standard, so the
  documented "the original is untouched" was false for any request with a body.
  It now constructs from a `clone()`.
- **Two ISG request-sanitization assertions were over-loosened** from `toEqual`
  to `toMatchObject` by a bulk edit, weakening exactly the check that proves no
  request-specific header reaches a shared-cache render. Restored.

Also fixed from the same reviews: a broken `/docs/mcp` link, a changeset bump for
a package with no changes, `CDN-Cache-Control` and friends not counting as an
author-set policy, the revalidation `503` body missing `details`, and missing
`keyId`/`agent`-URL validation in the signer.

The signer's default covered-component set (`@authority` + `signature-agent`)
was reviewed and deliberately **kept**: it is what the Web Bot Auth draft
specifies, and widening it by default risks interop with other verifiers. The
consequence — a captured signature is replayable against any endpoint on the
same host until it expires — is now called out in `docs/AGENT_TRUST.md` with the
`additionalComponents` remedy, rather than left implicit.

The tree passes `CI=1 pnpm run verify` (build, format, lint, generated types,
generated typecheck, workspace typecheck, unit tests, Playwright E2E) on top of
`origin/main` at `8c1a9a7`.

## Findings

Severity reflects adoption impact and how likely a user is to mistake the failure
for their own bug.

---

### F-01

#### Vercel ISG webhook revalidation can never authenticate

**Severity:** High &nbsp;·&nbsp; **Category:** Runtime bug (shipped in published packages)

`POST /__pracht/revalidate` on the Vercel adapter answers `401 Unauthorized` for
every request, no matter what `PRACHT_REVALIDATE_TOKEN` is set to. Webhook-based
ISG revalidation is entirely non-functional on Vercel.

The token lookup is written to survive bundling:

```ts
// packages/adapter-vercel/src/index.ts
function getRuntimeRevalidationToken(): string | undefined {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env?.[PRACHT_REVALIDATE_TOKEN_ENV];
}
```

The adapter's own `dist` is fine (`return globalThis.process?.env?.[...]`), but the
**app** build's `process.env` define matches the member expression through the
`globalThis` indirection and collapses it. In the emitted function bundle:

```js
// examples/basic/.vercel/output/functions/render.func/server.js
function getRuntimeRevalidationToken() {
	return {}?.[PRACHT_REVALIDATE_TOKEN_ENV];
}
```

The function therefore always returns `undefined`, `readRevalidationRequest()`
fails closed, and the endpoint answers `401`.

Reproduction:

```sh
cd examples/basic
PRACHT_ADAPTER=vercel pnpm exec pracht build
PRACHT_REVALIDATE_TOKEN=t node --input-type=module -e '
  const m = await import("./.vercel/output/functions/render.func/server.js");
  const r = await m.default(new Request("https://x.test/__pracht/revalidate", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify({ paths: ["/pricing"] }),
  }), { waitUntil() {} });
  console.log(r.status, await r.text());   // 401 {"error":"Unauthorized"}
'
```

Causation was proven by editing that one line in the built bundle back to
`globalThis.process?.env?.[...]` and re-running the same request: `200
{"failed":[],"revalidated":[],"skipped":["/pricing"]}`.

Scope:

- Both emitted function types are affected — the Edge render function and the
  Node ISG launcher (`pricing.func/server.js` contains the same collapsed call).
- It reproduces against **published** packages. A `create-pracht --adapter=vercel`
  project on `@pracht/adapter-vercel@0.2.8` emits `return {}[PRACHT_REVALIDATE_TOKEN_ENV]`
  and answers `401`.
- Node (`process.env[...]` directly) and Cloudflare (`env` binding) are unaffected
  and were verified working.

The rest of the framework already avoids this class of bug by reading through
`serverEnv` — that is how `PRACHT_CONFIRMATION_SECRET` survives the same build
(the destructive prepare/commit flow works correctly on Vercel).

`docs/ADAPTERS.md` describes Vercel's runtime-versus-build-time token semantics in
detail, which implies the runtime path authenticates. It cannot.

**Suggested action:** read the token through `serverEnv` like the rest of the
framework, and add an adapter integration test that drives the built Vercel bundle's
revalidate endpoint with the env var set — a unit test against `src/` cannot catch
this, because the defect is introduced by the app build.

---

### F-02

#### Every checked-in Cloudflare example omits `html_handling`, including the docs site

**Severity:** Medium &nbsp;·&nbsp; **Category:** Example/deployment footgun

`docs/ADAPTERS.md` documents the trailing-slash divergence, says `create-pracht`
writes `"html_handling": "drop-trailing-slash"`, and tells existing apps to add it.
None of the three checked-in Cloudflare configs do:

- `examples/basic/wrangler.jsonc`
- `examples/cloudflare/wrangler.jsonc`
- `examples/docs/wrangler.jsonc`

Measured against the same build of `examples/basic`:

| Request | Node | Cloudflare | Vercel |
| --- | --- | --- | --- |
| `GET /products/1` | `200` | `307 → /products/1/` | `200` |
| `GET /pricing` | `200` | `307 → /pricing/` | `200` |

The generated `llms.txt` emits the non-slash form, so an agent following it takes a
redirect on every prerendered page — on Cloudflare only. This reproduces on the
project's own production site:

```
$ curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" https://pracht.resynapse.dev/docs/routing
307 -> https://pracht.resynapse.dev/docs/routing/
```

`create-pracht` gets this right, so only existing apps and the project's own
examples are exposed — but the examples are what users copy, and the docs site is
the reference deployment.

**Suggested action:** add `"html_handling": "drop-trailing-slash"` to the three
example configs, and consider a `pracht doctor` / `pracht verify` check that flags
a Cloudflare app whose assets binding leaves `html_handling` at its default while
the app has prerendered routes.

---

### F-03

#### `examples/basic` publishes an llms.txt that lists endpoints agents cannot use

**Severity:** Medium &nbsp;·&nbsp; **Category:** Example/agentic-surface gap

The canonical example's generated `llms.txt` advertises:

```
## Pages
- [/dashboard](/dashboard)
- [/settings](/settings)

## API
- [/api/_pracht/image](/api/_pracht/image): GET, HEAD
```

Measured behavior for an anonymous agent following that index:

| Listed URL | Actual response |
| --- | --- |
| `/dashboard` | `302 → /` (auth middleware) |
| `/settings` | `302 → /` (auth middleware) |
| `/api/_pracht/image` | framework-internal image endpoint, not an app API |

The `llmsTxt.exclude` option exists and its own doc comment warns about precisely
this — *"llms.txt invites agents to fetch every URL it lists, so exclude anything
an anonymous agent cannot use — pages behind an auth middleware, internal
tooling"* — but `examples/basic/vite.config.ts` does not use it. The example that
demonstrates the agentic surface demonstrates the anti-pattern its own option
documents.

Separately, `/api/_pracht/*` is a framework-reserved namespace. Emitting it as an
app API endpoint is noise in every app that uses `@pracht/image`, not just this
one.

**Suggested action:** set `llmsTxt: { exclude: ["/dashboard", "/settings"] }` in the
example, and exclude the `/_pracht/**` reserved namespace from llms.txt by default
rather than requiring every app to opt out of it.

---

### F-04

#### The public docs never say the pages router has no agentic surface

**Severity:** Medium &nbsp;·&nbsp; **Category:** Documentation gap / adoption footgun

`docs/ROUTING.md` carries a precise comparison table:

```
| Capabilities | ❌ — and therefore no capability HTTP endpoints, no WebMCP,
                    no remote MCP, no `pracht eval` |
| defineApp({ constraints }), agents | ❌ |
| Middleware | ❌ no registration seam |
```

That table exists only in the repository. On the public site, `examples/docs`
mentions the pages-router limitation for **constraints** (agent-workflow.md) and
offers a higher-order-function workaround for **middleware** (middleware.md,
api-routes.md, recipes-logging.md) — but nowhere states that capabilities, WebMCP,
remote MCP, Web Bot Auth, and `pracht eval` are unavailable. Grepping every public
docs page for that combination returns nothing.

`create-pracht` presents the two routers as equals:

```
Router:
  1. Manifest (explicit routes.ts)
  2. Pages (file-system routing)
```

The generated `AGENTS.md` *does* spell out the limitation for coding agents, so an
agent working in the project is informed. A human choosing option 2 at the prompt
is not, and neither is a reader of the public site. Capabilities are the product's
headline bet; losing them should not be a discovery made later.

Verified end to end: `pracht inspect capabilities` in `examples/pages-router`
reports "No capabilities registered", and the plugin explicitly warns that
`pagesDir` makes `appFile` ignored — so there is no seam to register them through.

**Suggested action:** port the `docs/ROUTING.md` comparison table to the public
routing page, cross-link it from the capabilities and agents pages, and add a
one-line consequence note to the `create-pracht` router prompt.

---

### F-05

#### The canonical example teaches `throw new Error` where the docs teach `notFound()`

**Severity:** Medium &nbsp;·&nbsp; **Category:** Example contradicts documentation

`examples/basic/src/routes/product.tsx`:

```ts
export function loader({ params }: LoaderArgs) {
  const product = PRODUCTS.find((p) => p.id === params.productId);
  if (!product) throw new Error("Product not found");
  return product;
}
```

`GET /products/99` — a dynamic SSG path `getStaticPaths()` did not enumerate, which
correctly falls through to a server render — therefore answers:

```
500  content-type: text/plain; charset=utf-8
Internal Server Error
```

on all three adapters, bypassing the app's `notFound` page entirely. The framework
is behaving correctly; the example is wrong. `docs/DATA_LOADING.md` and
`docs/ROUTING.md` both prescribe `throw notFound()` for exactly this case, and
`notFound` is exported from `@pracht/core`.

Un-enumerated dynamic paths are the single most common way a reader will exercise
this route, and the example is the reference for "what does a loader do when the
record is missing".

**Suggested action:** use `throw notFound("Product not found")` in the example, and
consider an `ErrorBoundary` export on the same route so both documented recovery
paths are demonstrated.

---

### F-06

#### The docs site's llms.txt contains raw HTML inside Markdown

**Severity:** Medium &nbsp;·&nbsp; **Category:** Agentic-surface content bug

`https://pracht.resynapse.dev/llms.txt` emits entries like:

```
- [Agent Skills](…/docs/agent-skills): pracht ships 28 Claude Code skills … seeded
  into new apps by <code>create-pracht</code>, and pair with the built-in MCP server.
- [Forms](…): Handle form submissions … using pracht's <code>&lt;Form&gt;</code> component …
```

llms.txt is Markdown. The descriptions come from the `lead:` frontmatter field of
each docs page, and 11 of those fields contain literal `<code>` tags — one also
contains HTML entities (`&lt;Form&gt;`). Every agent that reads the project's own
agentic index gets markup noise and, in the `&lt;` case, double-escaped text.

```sh
$ grep -c '^lead:.*<code>' examples/docs/src/routes/docs/*.md | grep -v ':0' | wc -l
11
```

This is the project's own showcase of the agentic web, so it is worth more than its
raw severity.

**Suggested action:** use backticks in `lead:` and let the HTML renderer convert
them, or convert inline code to backticks in the llms.txt generator. A test that
asserts the generated llms.txt contains no `<` would keep it fixed.

---

### F-07

#### Nothing in the framework can sign a Web Bot Auth request, including `pracht eval`

**Severity:** Medium &nbsp;·&nbsp; **Category:** API-surface / agentic-workflow gap

Pracht ships the verifier (`verifyAgentSignature`, `defineApp({ agents.webBotAuth })`)
and documents the wire format thoroughly, but ships no signer. Searching every
package for RFC 9421 signing turns up nothing; the only working implementation in
the repository is a private helper inside `e2e/capabilities.test.ts`.

The consequence lands hardest on `pracht eval`, the framework's own agent-task
harness. A scenario step accepts only static headers:

```ts
// packages/cli/src/eval-runner.ts
headers?: Record<string, string>;
```

A Web Bot Auth signature covers `@authority` and carries `created`/`expires`
timestamps, so it cannot be expressed as a static string. `agent.ping` in
`examples/basic` declares `agentPolicy: "require"` and is therefore **unreachable
by `pracht eval`** — the example's own eval file skips it, and the showcase's
`agent.brief` step can only assert the `401 agent_required` rejection, never the
success path.

So the framework can prove the "unsigned callers are refused" half of agent trust
in CI, but not the "verified agents are served" half — that is covered only by
Playwright, using a helper that is not part of the public API.

Verified working by hand: a signed request built from that e2e helper verifies
correctly on Node, Cloudflare (workerd) and Vercel, returning
`{"verified":true,"agentDomain":"test-agent.example",…}` and passing `agent.ping`.
The capability is sound; the tooling around it is missing.

**Suggested action:** export a signing helper (or a `@pracht/agent-client` test
utility) and teach `pracht eval` a per-scenario `signAs: { jwk, keyId, agent }`
block so `agentPolicy: "require"` capabilities become testable.

---

### F-08

#### SSR and API responses carry no `Cache-Control` on Node and Vercel, but do on Cloudflare

**Severity:** Medium &nbsp;·&nbsp; **Category:** Cross-adapter inconsistency

Same app, same build, same route:

| Route | Node | Cloudflare | Vercel |
| --- | --- | --- | --- |
| `/notes` (SSR) | *(no `Cache-Control`)* | `private, no-cache` | *(no `Cache-Control`)* |
| `/api/health` | *(no `Cache-Control`)* | `private, no-cache` | *(no `Cache-Control`)* |
| `/nope` (404) | *(no `Cache-Control`)* | `private, no-cache` | *(not measured)* |

The Cloudflare adapter's `cache.ts` stamps `private, no-cache` on any GET/HEAD
response that has no caching policy, with a well-argued comment: a shared cache
that applies RFC 9111 heuristic freshness would otherwise store authenticated SSR
pages, since `Cookie` is not part of the cache key. That reasoning is not
Cloudflare-specific — it applies to any CDN or reverse proxy in front of a Node or
Vercel deployment.

Two consequences:

1. The safety property is adapter-dependent, which cuts against "deploy anywhere".
   An app hardened on Cloudflare loses the protection when it moves to Node.
2. `docs/ADAPTERS.md` files that bullet under **"With the option on:"** in the
   Workers Caching section, so it reads as gated on `cloudflareAdapter({ cache: true })`.
   It is not — the stamping is unconditional (`applyDefaultCacheControl` runs on
   every response), and was observed with the default adapter.

**Suggested action:** decide whether the default belongs in the shared runtime
rather than one adapter; either way, move the bullet out of the "with the option
on" list and document the Node/Vercel gap in their adapter sections.

---

### F-09

#### `POST /__pracht/revalidate` reports `skipped` with no reason

**Severity:** Low &nbsp;·&nbsp; **Category:** Debuggability

Three unrelated causes produce byte-identical output:

```sh
# route does not opt into webhookRevalidate()
{"paths":["/pricing"]}      → {"failed":[],"revalidated":[],"skipped":["/pricing"]}
# not an ISG route
{"paths":["/notes"]}        → {"failed":[],"revalidated":[],"skipped":["/notes"]}
# path does not exist at all (typo)
{"paths":["/no-such-page"]} → {"failed":[],"revalidated":[],"skipped":["/no-such-page"]}
```

`docs/ADAPTERS.md` lists all three reasons, so the behavior is correct — but an
operator wiring a CMS webhook gets a `200` with an unexplained skip and no way to
tell a configuration mistake from a typo. `failed` has the same shape.

This is compounded by the fact that **no route in `examples/basic` opts into
`webhookRevalidate()`** — `/pricing` is `timeRevalidate(3600)` only — so the first
thing a reader tries against the canonical example silently does nothing.

**Suggested action:** return `skipped` as `{ path, reason }` objects
(`not_isg` / `not_prerendered` / `no_webhook_policy`), and give the example a route
with `revalidate: [timeRevalidate(...), webhookRevalidate()]`.

---

### F-10

#### Two different documents compete for the name `llms.txt`, and one silently overwrites the other

**Severity:** Low &nbsp;·&nbsp; **Category:** API-surface confusion / silent data loss

`pracht llms --write` writes an **authoring guide for coding agents** (83 lines of
framework conventions) to `./llms.txt` in the app root. The `llmsTxt` plugin option
emits a completely different document — the **app's own agent index** — to
`dist/client/llms.txt`, served at `/llms.txt`. Same filename, same project, two
unrelated meanings, and the root copy is not gitignored.

Separately, a hand-authored `public/llms.txt` is silently overwritten:

```sh
$ printf '# HAND WRITTEN\n' > public/llms.txt
$ pnpm run build          # exit 0, no warning
$ cat dist/client/llms.txt
# n1
## Pages
- [/](/)
```

Nothing in `docs/LLMS_TXT.md` mentions the collision. A user who wants to hand-tune
their index has no way to discover that the build discards it.

**Suggested action:** warn (or fail) when `public/llms.txt` exists alongside
`llmsTxt`, and rename the CLI output to something unambiguous
(`pracht llms --write` → `AGENTS.md`-adjacent, or `--out <path>`).

---

### F-11

#### `pracht plan` and `pracht report` leak raw git errors

**Severity:** Low &nbsp;·&nbsp; **Category:** Polish

> **Withdrawn on verification.** This does not reproduce on `main`: both git
> call sites (`graph-snapshot.ts`, `verification-scope.ts`) already pass
> `stdio: ["ignore", "pipe", "ignore"]` with a comment explaining exactly this.
> The audit ran the command through `pnpm exec`, which resolves the *published*
> `@pracht/cli@1.9.0` — where it does leak. Re-read as an instance of
> [F-15](#f-15). The observation below is what the published CLI does.

Outside a git repository, both commands print git's own error before their handled
message:

```
$ pracht plan
fatal: not a git repository (or any of the parent directories): .git
Pracht plan (no baseline snapshot — every entry shows as added)
+ route /  render=ssg  shell=public  middleware=[]
```

The graceful path is already implemented; the child process's stderr just is not
suppressed. Reproducible in any `create-pracht --no-git` project, and in CI systems
that check out without `.git`.

**Suggested action:** capture the git subprocess's stderr and discard it on the
expected "not a repository" / "unknown revision" paths.

---

### F-12

#### The app-graph snapshot is advertised in fresh projects but never created, and `verify` is silent about it

**Severity:** Low &nbsp;·&nbsp; **Category:** Adoption gap

A fresh scaffold ships this in `.gitignore`:

```
# Keep .pracht/app-graph.json committed — it is the `pracht plan` snapshot.
```

…but no `.pracht/` directory, and neither the published nor the current `pracht
verify` mentions the snapshot at all in a project that lacks one:

```
$ pracht verify        # 9 OK lines, "No blocking issues found."
$ pracht verify | grep -i snapshot
(no mention)
```

By contrast `examples/showcase`, which has committed one, gets
`OK  App graph snapshot .pracht/app-graph.json is up to date.` So the staleness
guarantee described in `VISION_MVP.md` ("verify fails when the snapshot is stale")
is real, but only for projects that already discovered `pracht plan --write`. A new
project's `.gitignore` refers to a file that does not exist and nothing ever
suggests creating it.

`pracht plan` does print the hint, but only if the user runs `plan` — which they
have no reason to do before they have a baseline.

**Suggested action:** seed `.pracht/app-graph.json` during scaffolding (the graph
is already computed at that point), or have `verify` emit an informational line
when no snapshot exists.

---

### F-13

#### Generated projects mix package managers

**Severity:** Low &nbsp;·&nbsp; **Category:** Scaffolding polish

> **Partly withdrawn on verification.** The Dockerfile claim below is wrong:
> `createDockerfile(packageManager)` already emits pnpm/yarn/npm variants with
> the matching lockfile and `corepack enable`. The audit saw npm because it
> invoked `create-pracht` through `node …/bin/create-pracht.js`, which carries
> no `npm_config_user_agent` — so npm detection was correct for that
> invocation. Scaffolding under a pnpm agent emits `RUN pnpm install` and
> `COPY package.json pnpm-lock.yaml* ./`.
>
> The unconditional `pnpm-workspace.yaml` is **deliberate**: a test named
> "keeps the inert standalone pnpm policy for other package managers" asserts
> it, so a user who scaffolds with npm and later runs `pnpm install` still has
> a build-script policy for the edge adapters. Left unchanged.
>
> The `.mcp.json` version skew was real and is fixed.

Every generated project — including Node, and regardless of the detected package
manager — contains:

- `pnpm-workspace.yaml` with `packages: ["."]` plus an `allowBuilds` policy. This
  makes a standalone app a pnpm workspace **root**, which changes pnpm's behavior
  and conflicts with nesting the app inside an existing monorepo. It is inert dead
  weight for npm, yarn, and bun users.
- a `Dockerfile` hardcoded to npm (`COPY package-lock.json*`, `RUN npm install`,
  `npm prune --omit=dev`) even when the project was scaffolded with pnpm — the
  lockfile is not copied and the image resolves fresh versions at build time.
- `.mcp.json` pointing at `npx --yes @pracht/cli mcp`, i.e. floating `latest`
  rather than the CLI version the project pins. The MCP server an agent talks to
  can silently drift from the CLI the project builds with.

The `allowBuilds` policy is the F-04 remediation and is genuinely needed for the
edge adapters; the issue is that it is delivered through a file that has other
semantics, and unconditionally.

**Suggested action:** emit `pnpm-workspace.yaml` only for pnpm scaffolds that need
it, template the `Dockerfile` per package manager, and point `.mcp.json` at the
locally installed CLI.

---

### F-14

#### Smaller API-surface and polish observations

**Severity:** Low

Grouped because each is small on its own.

- **No `--config` or `--adapter` escape hatch on any CLI command.** `pracht build`
  cannot select an adapter, so multi-target apps hand-roll
  `process.env.PRACHT_ADAPTER` in `vite.config.ts` (as `examples/basic` does) with
  no framework support or documentation for the pattern. Relatedly,
  `docs/ADAPTERS.md`'s own local-preview workaround for custom-domain routes tells
  users to run `npx wrangler dev --config wrangler.local.jsonc` — the documented
  path requires abandoning `pracht preview`, because it does not forward `--config`.
- **`--tailwind` / `--no-tailwind` silently override `--template`.**
  `create-pracht --template=tailwind --no-tailwind` produces a minimal project with
  no error and no warning. The precedence is undocumented in `--help`.
- **`pracht build --no-budget-fail` help text describes the positive behavior under
  the negative flag name:** `"Fail the build when a client JS budget is exceeded
  (--no-budget-fail to disable)"`.
- **`x-pracht-isg` is undocumented in `docs/ADAPTERS.md`** (it appears only in a
  `REQUEST_FLOWS.md` diagram), and it is absent on Cloudflare when the build-time
  snapshot answers from the assets binding — exactly the case an operator is most
  likely to be debugging. Node stamps `fresh`/`stale` there.
- **Generated `package.json` key order** puts `dependencies`/`devDependencies`
  before `name`, and `tsconfig.json` is emitted with 4-space indentation while the
  rest of the scaffold uses 2.

---

### F-15

#### Release lag is user-visible because every scaffold installs the published CLI

**Severity:** Low &nbsp;·&nbsp; **Category:** Release hygiene

Two capabilities documented on `main` do not exist in the `@pracht/cli@1.9.0`
currently on npm — which is exactly what `create-pracht` pins:

| | published 1.9.0 | repo (also reports 1.9.0) |
| --- | --- | --- |
| `pracht generate capability` | `ERROR Unknown command capability` | works |
| `pracht inspect routes` | `hydration=n/a`, no `shell=` | `hydration=full  shell=public` |

`docs/CAPABILITIES.md:57` documents `pracht generate capability --name …` as
available. A user following it in a freshly generated project gets an error.

Both are covered by pending changesets, so this is the expected pre-release state
rather than a defect — but it is worth recording that the repository's docs and the
package a new user installs describe different command surfaces, and that the two
report the same version string.

**Suggested action:** none beyond releasing; optionally note "requires
`@pracht/cli` ≥ x.y" beside newly added commands in the docs.

---

## Confirmed working

Recorded so a future pass does not re-derive them. All were exercised directly, not
inferred.

- **Capability HTTP projection** is uniform across Node, Cloudflare (workerd), and
  Vercel: `200` envelopes, `400 invalid_input` with JSON-pointer issue paths,
  `404 unknown_capability`, `405 method_not_allowed`, `401 agent_required`.
- **Destructive prepare/commit** works on all three adapters. Tokens bind to the
  input (a token issued for `{"titlePrefix":"Render"}` is rejected with
  `confirmation_invalid (input_mismatch)` when replayed against different input).
  Replay within the TTL is possible and is explicitly documented as a stateless-HMAC
  limitation with the approval-store remedy — not a defect.
- **Remote MCP** is spec-clean: `initialize` negotiates down to the latest supported
  version for unknown client versions, `MCP-Protocol-Version` response header
  matches the negotiated version, a mismatched request header is rejected with
  `400`, notifications return `202`, batching returns `-32600` with a clear message,
  malformed JSON returns `-32700`, unknown tools list the known names, destructive
  capabilities are absent from `tools/list` and rejected by `tools/call`, and
  `isError` results carry structured `_meta` diagnostics.
- **Web Bot Auth** verifies identically on Node, workerd, and the Vercel edge
  handler, including `agentPolicy: "require"` enforcement and rejection of a
  single-bit-flipped signature.
- **Human-approval mode** in `examples/showcase` correctly distinguishes
  "no confirmation secret" from "human approval mode without an authenticated
  principal" — the shared `confirmation_unavailable` code carries a specific
  message for each.
- **Islands** produce byte-identical prerendered output on all three adapters;
  `hydration: "none"` ships zero JavaScript.
- **The `pracht dev` banner** reports routes, API methods, capabilities, effect
  classes, exposures, HTTP paths, and the MCP endpoint. Re-exported API methods now
  resolve correctly (previous audit's F-09).
- **`/_pracht` devtools** is dev-only and correctly `404`s in production builds.
- **Revalidation input validation** rejects >64 paths with `400` and a clear message,
  and fails closed with `401` on a wrong token, on Node and Cloudflare.
- **All 24 scaffold permutations** dry-run, and six representative projects install,
  build, and typecheck against published packages under TypeScript 7 and Vite 8.2.
- **The previous audit's F-01, F-04, F-08, and F-09** were re-tested and are fixed:
  Cloudflare graph commands terminate, pnpm 11 installs cleanly, the public CLI page
  covers all 13 commands, and the dev banner resolves re-exported methods.

## Intentional limitations re-confirmed

Unchanged from the previous audit and not treated as defects: Vercel has no faithful
local preview; Node and Vercel cannot serve WebSocket upgrades through the adapter
contract; remote MCP omits resources, prompts, OAuth, and streaming transports;
destructive capabilities are deliberately unavailable over WebMCP and MCP; MCP Apps
UI is unbuilt; Cloudflare Cache API locality and Workers Caching query cardinality
are platform properties.

Not exercised in this pass, and called out rather than assumed: `cloudflareAdapter({ cache: true })`
edge-tier behavior (local `wrangler dev` does not faithfully emulate Workers
Caching), and any behavior that requires a real Cloudflare or Vercel deployment.

## Recommended order of work

1. Fix the Vercel revalidation token read ([F-01](#f-01)) and add a built-bundle
   integration test — it is the only functional runtime break, and it ships today.
2. Correct the three example `wrangler.jsonc` files and the example llms.txt
   exclusions ([F-02](#f-02), [F-03](#f-03)) — cheap, and they are what users copy.
3. Fix `product.tsx` to use `notFound()` ([F-05](#f-05)) and strip HTML from the
   docs `lead:` fields ([F-06](#f-06)).
4. Publish the pages-router capability limitation on the public site and in the
   scaffold prompt ([F-04](#f-04)).
5. Ship a Web Bot Auth signer and teach `pracht eval` to use it ([F-07](#f-07)) —
   without it, half of the agent-trust story is untestable in CI.
6. Decide where the default `Cache-Control` belongs ([F-08](#f-08)).
7. Work through the low-severity polish items ([F-09](#f-09)–[F-14](#f-14)).

## Reproduction notes

```sh
pnpm install --frozen-lockfile && pnpm run build
CI=1 pnpm run verify --skip-build

# Node
cd examples/basic && PRACHT_ADAPTER=node pnpm exec pracht build
PORT=4599 PRACHT_CONFIRMATION_SECRET=… PRACHT_REVALIDATE_TOKEN=… node dist/server/server.js

# Cloudflare (real workerd)
PRACHT_ADAPTER=cloudflare pnpm exec pracht build
pnpm exec wrangler dev --config wrangler.local.jsonc --port 4600 --inspector-port 9330

# Vercel (invoke the generated handlers directly)
PRACHT_ADAPTER=vercel pnpm exec pracht build
node --input-type=module -e 'import("./.vercel/output/functions/render.func/server.js")…'

# Scaffolds
node packages/start/bin/create-pracht.js <dir> --adapter=… --router=… --template=… --yes

pnpm exec pracht eval --url http://localhost:<port>
pnpm --dir examples/showcase run eval
```

Temporary artifacts created during this audit and reverted afterwards: a
`wrangler.local.jsonc` in `examples/basic` (custom-domain route removed so the
Worker's request authority matches the preview URL — see the previous audit's
F-07), a parameterized adapter selection in `examples/islands/vite.config.ts` with
two `node_modules/@pracht/*` symlinks, a `public/llms.txt` and a root `llms.txt` in
a generated project, and one patched line in a built Vercel bundle used to prove
[F-01](#f-01)'s causation. `git status` is clean; generated projects live under
`/tmp/pracht-audit`.
