# Framework permutation audit follow-up — 2026-08-11

## Purpose

This is a fresh residual audit of the human and agentic framework surfaces after
the twelve findings in
[`FRAMEWORK_PERMUTATION_AUDIT_2026-08-10.md`](FRAMEWORK_PERMUTATION_AUDIT_2026-08-10.md)
were remediated. It focuses on cross-products that the earlier audit did not
fully execute: render mode × hydration mode, pages router × edge adapter,
WebMCP × islands rendering, and the difference between the guidance shown to a
human and the guidance seeded for an agent.

The goals were to find:

- gaps in the public `examples/docs` site;
- misleading or incomplete API surfaces;
- adoption footguns in generated projects and deployment workflows;
- runtime bugs on the human or agentic surface.

This report records the original evidence, the implemented remediation, and
the proof used to close each finding.

## Remediation status

| Finding | Status | Fix and proof |
| --- | --- | --- |
| F-01 | Fixed | The generated server carries an explicit per-app bootstrap requirement through dev, prerendering, and all built-in adapters. Zero-island WebMCP pages register and execute the real tool; `hydration: "none"` stays script-free; error-boundary and cross-app isolation regressions are covered. |
| F-02 | Fixed | Pages can export a positive integer `REVALIDATE` time policy. Build, `doctor`, and `verify` reject missing, malformed, or misplaced policies. Static discovery ignores comments, strings, and root or nested Markdown fences; `_app`/`404` policy misuse fails closed. Node, Cloudflare, and Vercel builds emit their native ISG metadata with the exact interval. |
| F-03 | Fixed | Public routing/getting-started/capability docs, root references, the pages example, authoring guide, generated README/AGENTS guidance, and bundled skills now share the pages-router boundary and ISG contract. Scaffold parity tests cover both audiences. |

## Test baseline

- Commit: `f840b1f399aad261dcafc0d0d420a0daa007371a` (`origin/main`)
- Node.js: `v22.22.3`
- pnpm: `11.3.0`
- Host: macOS
- External deployments: not created

Cloudflare was exercised with the generated Worker under `wrangler dev`.
Vercel was exercised through Build Output API v3 artifacts and the exported
edge handler. Node was exercised through the generated production server.

## Coverage

### Scaffold matrix

All 24 `create-pracht` dry-run combinations emitted the expected files:

- adapters: Node, Cloudflare, Vercel;
- routers: manifest, pages;
- templates: minimal, Tailwind;
- agent tooling: enabled, disabled.

The checks verified adapter/router/template metadata, the presence of
`.mcp.json` and the skill catalog only when agent tooling was enabled, and the
absence of those files when it was disabled.

Fresh pages-router projects were then generated for all three adapters. Each
project built and typechecked against the packages in this workspace. Their
human runtime paths were exercised as follows:

| Adapter | Runtime | Human probes | Result |
| --- | --- | --- | --- |
| Node | generated production server | `/`, `/api/health`, `/llms.txt`, custom 404 | Passed |
| Cloudflare | `wrangler dev` production preview | `/`, `/api/health`, `/llms.txt`, custom 404 | Passed |
| Vercel | exported edge handler | `/`, `/api/health`, custom 404 | Passed |

For the authoring-agent surface, `pracht inspect routes --json`, `pracht
doctor --json`, build, and typecheck succeeded on all three pages-router
projects. Pages mode intentionally has no runtime capabilities, WebMCP, remote
MCP, `agents`, or constraints because those registrations require the explicit
manifest.

### Render and hydration matrix

The ten supported render/hydration combinations were put in one manifest app:

| Render | `full` | `islands` | `none` |
| --- | --- | --- | --- |
| SSG | Tested | Tested | Tested |
| SSR | Tested | Tested | Tested |
| ISG | Tested | Tested | Tested |
| SPA | Tested | Invalid by design | Invalid by design |

All ten routes built successfully with Node, Cloudflare, and Vercel: 30 build
combinations. The same ten routes were requested from each real local runtime
surface:

- Node generated production server: 10/10 returned 200 with the expected
  full-client, islands-bootstrap, or zero-JavaScript shape;
- Cloudflare workerd preview: 10/10 returned 200 after expected static-route
  trailing-slash redirects, with the expected JavaScript shape;
- Vercel exported edge handler: 10/10 returned 200 with the expected
  JavaScript shape.

The SPA restriction is correctly enforced by `resolveApp()`: SPA always uses
full hydration, while `spa` + `islands`/`none` is a configuration error.

### Human and agentic manifest surfaces

The same capability-enabled manifest was built or served on all three
adapters. The following paths passed on Node, Cloudflare, and Vercel:

- human SSR page (`/notes`);
- typed HTTP capability (`notes.search`);
- remote MCP discovery (`tools/list`, exposing `notes_search` and
  `notes_create`);
- human approval boundary for destructive HTTP capabilities (prepare returns
  `409 confirmation_required`; an identical confirmed request commits);
- production output contains the WebMCP chunk when a capability opts in.

The repository's focused browser/deployment rerun passed 33/33 tests, covering
the generated capability client, `<Form capability>`, `useCapability`, WebMCP,
remote MCP, eval, Node output, Vercel output, and client/server bundle
boundaries. The final repository gate is recorded under
[Verification](#verification).

## Findings

Severity reflects adoption impact and how likely the behavior is to remain
silent until production.

### F-01 — WebMCP silently disappears from islands routes that render zero islands

**Severity:** High

**Category:** Agentic runtime bug

The public capability guide says the WebMCP shim works in both full-hydration
and islands modes. The generated islands bootstrap does contain the WebMCP
feature detection and registration import. However, the server injects that
bootstrap only when the current render captured at least one island component.

A route with all of the following conditions therefore exposes no WebMCP
tools:

```ts
route("/notes", () => import("./routes/notes.tsx"), {
  render: "ssr",
  hydration: "islands",
});
```

- the app registers an `expose.webmcp: true` capability;
- the app has a valid `src/islands/` directory and the islands/WebMCP chunks
  are present in the client build;
- this particular response renders zero island components.

The observed HTML contained no Pracht client or islands script. The control
route that rendered one island contained the islands bootstrap, and that
bootstrap contained the WebMCP registration code. The result reproduced in
development and in the Node, Cloudflare, and Vercel production output paths.

The other projections remained healthy: the human page returned 200, the HTTP
capability returned its typed success envelope, and remote MCP listed the
tools. Only the in-page agent projection silently vanished.

This is also data-dependent. If an island is conditional on loader data, the
same URL can advertise WebMCP on one response and omit it on another even
though `pracht inspect capabilities`, generated types, and the capability graph
remain unchanged.

**Recommended action:** inject a WebMCP-capable bootstrap for every
`hydration: "islands"` response when the app has a WebMCP projection, even when
the island capture is empty. Alternatively, emit a separate minimal WebMCP
entry independent of island usage. Add production and dev tests for zero,
one, and conditionally rendered islands.

### F-02 — Pages-router `isg` is accepted but silently produces immutable SSG output

**Severity:** High

**Category:** API/runtime/tooling footgun

The public pages-router guide lists `"isg"` as a valid `RENDER_MODE`. The pages
manifest generator extracts `RENDER_MODE` and `HYDRATION`, but it has no export
or plugin option for a per-route revalidation policy. The resolved graph can
therefore contain this state:

```json
{
  "path": "/",
  "render": "isg",
  "revalidate": null
}
```

Fresh Node, Cloudflare, and Vercel pages-router starters were changed from
`RENDER_MODE = "ssg"` to `RENDER_MODE = "isg"` and rebuilt. All three builds
succeeded, but all three emitted static HTML with no runtime ISG mechanism:

- Node: `dist/client/index.html`, no `dist/server/isg-manifest.json`;
- Cloudflare: static `index.html`, no server/client ISG manifest;
- Vercel: `.vercel/output/static/index.html`, no route function and no
  `.prerender-config.json`.

`pracht doctor --json` and `pracht verify --json` both reported `ok: true` on
all three projects. No build warning explained that the route was frozen.

The shipped `configure-isg` skill already knows the limitation and says that a
pages-router `isg` route silently behaves like SSG unless the app ejects to an
explicit manifest. That warning does not appear in the public routing or
rendering docs, the generated human README, `doctor`, `verify`, or build
output.

**Impact:** a developer can choose a documented render mode, deploy
successfully, and discover later that pricing, catalog, CMS, or other supposedly
revalidated content never changes.

**Recommended action:** either add a pages-router revalidation contract (for
example, a statically analyzable `REVALIDATE` export) or reject pages-router
`isg` in graph resolution until it can carry a policy. At minimum, `doctor`,
`verify`, and `build` should fail closed or emit a prominent warning, and the
public docs should direct users to eject before configuring ISG.

### F-03 — The public pages-router guide omits its manifest-only feature boundary

**Severity:** Medium

**Category:** Human/agent documentation parity gap

The root routing reference and generated `AGENTS.md` accurately state that
pages mode has no registration seam for:

- named shells or per-route shell assignment;
- manifest middleware;
- capabilities and therefore capability HTTP endpoints, WebMCP, remote MCP,
  and `pracht eval`;
- `defineApp({ constraints })` and `agents`.

The public `examples/docs` pages-router section omits that table and moves
directly from its introduction to setup. The getting-started guide also says
the adapter and router can be changed later in `vite.config.ts` without
explaining that switching to pages mode removes these features or that moving
back requires an eject/code-generation step.

The generated human README for a pages-router starter likewise lists files,
commands, skills, and MCP setup without the limitations. The generated
`AGENTS.md` does include the complete warning. An agent is therefore given a
more accurate product boundary than the human who created the project or read
the public site.

**Impact:** users can select pages routing for an agent-ready application and
only discover after adoption that the runtime agent surface and policy model
require a router migration.

**Recommended action:** copy the curated limitation/ejection table from
`docs/ROUTING.md` into `examples/docs/src/routes/docs/routing.md`, link it from
getting started and capabilities, and include the same warning in the
generated human README. Keep the human README and `AGENTS.md` assertions under
one scaffold parity test.

## Confirmed behavior and intentional limitations

The audit also confirmed the following and did not classify them as defects:

- All 24 scaffold file permutations are internally consistent.
- Node, Cloudflare, and Vercel fresh pages-router starters build and typecheck.
- All ten valid render/hydration combinations behave consistently across the
  three adapters.
- `spa` + `islands`/`none` is rejected by design.
- Pages mode supports human routes, `_app.tsx`, API routes, typed routes,
  authoring MCP/inspection, and generated agent skills; runtime capabilities
  remain a documented manifest-only feature in the root reference.
- A fresh project does not contain generated typed-route files until
  `pracht typegen` or `pracht dev` runs. `typegen --check` failing before that
  opt-in generation is expected and was not treated as a defect.
- Vercel still intentionally has no Pracht-owned faithful local production
  preview; direct Build Output handler execution was used instead.
- `hydration: "none"` intentionally ships no client code and therefore cannot
  host in-page WebMCP tools. F-01 concerns the explicitly supported islands
  mode, whose generated bootstrap promises WebMCP support.

## Verification

The audit reproduction baseline completed these commands and probes:

- `pnpm run build`: passed;
- 24/24 `create-pracht --dry-run --json` permutations: passed;
- three fresh pages-router adapter builds + typechecks: passed;
- 30 render/hydration adapter builds: passed;
- 10/10 Node production render/hydration requests: passed;
- 10/10 Cloudflare workerd render/hydration requests: passed;
- 10/10 Vercel handler render/hydration requests: passed;
- focused browser/deployment suite: 33/33 passed.

The remediation then added permanent regression coverage and completed:

- focused framework, code-generation, CLI, and built-in adapter unit suites:
  passed;
- a real browser WebMCP execution on `/agent-tools`, whose response renders no
  UI islands: passed;
- built Node server, Cloudflare Worker, and Vercel edge-handler requests to the
  same zero-island route: passed with a hashed bootstrap and no island marker;
- pages-router ISG builds for Node, Cloudflare, and Vercel: passed with the
  exact 60-second native policy, including a Vercel function and fallback but
  no static pricing route;
- adversarial parser cases for comment/string lookalikes, quoted config
  constants, unrelated duplicate config properties, root and CommonMark-nested
  fenced examples, top-level MDX exports, and `_app`/`404` misuse: passed;
- final `pnpm run verify`: passed build, formatting, lint, generated-type
  checks, typecheck, unit tests, and E2E.

Two independent adversarial review passes were run against the remediation.
They found and drove fixes for Node ISG regeneration propagation, misleading
zero-island diagnostics, missing Cloudflare/Vercel response assertions, an
undiscovered Playwright spec, comment/string/config spoofing, Markdown fence
handling, and ignored `_app` policies. Their final re-reviews reported no
remaining findings.

The in-app browser-control surface was unavailable during the initial focused
F-01 probe. The permanent Playwright regression now executes the registered
tool through `document.modelContext` on the zero-island route, and the three
built-in adapter tests request their emitted production handlers directly.
