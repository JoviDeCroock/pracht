# Framework permutation audit — 2026-08-10

## Purpose

This audit exercises Pracht as both a human-facing framework and an agent-facing
framework. It covers the built-in deployment adapters, both router modes, starter
variants, rendering modes, capabilities, WebMCP, remote MCP, Web Bot Auth, destructive
confirmation, and a representative human-approval workflow.

The goals were to find:

- gaps between runtime behavior and `examples/docs`;
- problems or confusing edges in the public API;
- adoption footguns in scaffolding, local development, and deployment;
- runtime and tooling bugs.

This is an evidence report, not a proposal to silently change current behavior.

## Test baseline

- Commit: `5879706092eeb2b0108f22615bb143e57df58955` (`origin/main`)
- Node.js: `v22.22.3`
- Repository package manager: pnpm `11.3.0`
- Generated-project package manager: pnpm `11.x`
- Host: macOS, local execution only

External Cloudflare and Vercel deployments were intentionally not created. Cloudflare
was exercised in the real local Workers runtime (`wrangler dev` through `pracht
preview`), and Vercel was exercised through its production build output and exported
edge handler. Results that need a deployed platform are called out explicitly.

## Coverage

### Deployment and interaction matrix

| Adapter/workflow | Human surface | Agentic surface | Destructive/human gate | Result |
| --- | --- | --- | --- | --- |
| Node production server | SSR, static, SPA, islands, API, auth redirects | HTTP capabilities, remote MCP, signed Web Bot Auth | prepare/commit confirmation | Passed |
| Cloudflare Workers preview | SSR, static, SPA, islands, API, browser WebMCP | HTTP capabilities, remote MCP, signed Web Bot Auth | prepare/commit confirmation | Passed after supplying the secret through `.dev.vars` |
| Vercel production output | SSR route and API through exported edge handler | capability HTTP, remote MCP, signed Web Bot Auth | artifact-level coverage | Passed; no faithful local preview exists by design |
| Showcase workflow | operator approval UI and admin API | signed agent script, HTTP and MCP discovery, idempotent deploy | exact proposal approved by a human session before commit | Passed |

Node production route probes covered `/`, `/notes`, `/products/1`, `/pricing`,
`/gallery`, protected redirects, a missing route, `/llms.txt`, API health, route state,
API validation, capability input validation, unsigned identity, and remote MCP trust
boundaries. Cloudflare repeated the same core probes in workerd. Vercel's generated
handler was directly invoked for an SSR page, capability HTTP, remote MCP, and signed
identity.

The repository browser suite covered human forms, WebMCP, signed Web Bot requests,
destructive confirmation, and MCP. An additional browser run against the Cloudflare
preview covered `<Form capability>`, the generated client, `useCapability`, native
WebMCP registration/execution, and the no-WebMCP fallback.

### Scaffold matrix

`create-pracht` exposes this Cartesian product:

- adapters: Node, Cloudflare, Vercel;
- routers: manifest, pages;
- templates: minimal, Tailwind;
- agent tools: enabled, disabled.

All 24 combinations completed a dry run with the expected adapter, router, template,
and agent-tool files. Eight representative projects were then installed and built:

- every adapter with both router modes, minimal template, and agent tools;
- Node with both router modes, Tailwind, and agent tools.

All eight built successfully after the Cloudflare/Vercel install-approval issue in
[F-04](#f-04--cloudflare-and-vercel-starters-are-blocked-by-pnpm-11-build-script-approval)
was resolved.

### Repository checks

- `pnpm run build`: passed.
- Full Playwright suite with `CI=1`: 123 passed.
- Focused capability browser suite: 27 passed.
- Focused adapter build E2E: 7 passed.
- Cloudflare-preview browser suite: 5 passed.
- Focused scaffold, Cloudflare adapter, and CLI MCP unit tests: 49 passed.
- Showcase `verify`, two eval scenarios, signed agent flow, and human approval: passed.

## Remediation — 2026-08-11

All twelve findings were fixed. The audit remains written in the present-tense state
observed at the baseline commit so that the original symptoms and reproduction context
are preserved; this table records the corresponding remediation now present in the
workspace.

| Finding | Status | Remediation |
| --- | --- | --- |
| F-01 | Fixed | Graph commands use a disposable Vite cache and Cloudflare graph-only runtime stubs; child-process tests require successful exit. |
| F-02 | Fixed | The basic example now resolves every adapter's API graph through stable module paths; Node, Cloudflare, and Vercel type generation must all match the committed declarations, which are compiled during repository verification. |
| F-03 | Fixed | Cloudflare Queue guidance uses `workerHandlersFrom`; named binding exports and default Worker handlers are documented separately. |
| F-04 | Fixed | Edge starters emit pnpm-major-aware build policies for pnpm 10 and 11, covered across adapter, router, and template permutations. |
| F-05 | Fixed | Each graph reader gets an isolated temporary cache that is removed after the command, including under concurrent execution. |
| F-06 | Fixed | Root and public adapter references now cover the omitted Node, Cloudflare, Vercel, ISG, cache, and preview behavior. |
| F-07 | Fixed | Custom-domain authority behavior is documented with runnable local-preview guidance that avoids the checked-in route. |
| F-08 | Fixed | The public CLI reference covers all thirteen shipped top-level commands. |
| F-09 | Fixed | Development API method discovery follows re-exports statically without evaluating application API modules. |
| F-10 | Fixed | Cloudflare local secrets use an ignored `.dev.vars`; environment docs distinguish Worker bindings from host shell variables. |
| F-11 | Fixed | Showcase verification and reporting share one cross-platform secret-aware script runner. |
| F-12 | Fixed | Graph-only MCP metadata is separated from request transports and edge builds explicitly classify the tree-shaken Node helper. |

Adversarial reviews exposed further integration defects in the initial
remediation. The fixes now present in the workspace include:

- graph mode originally removed Cloudflare module resolution needed by application
  contracts, so known `cloudflare:*` imports now resolve to non-executable inspection
  stubs and unknown imports fail descriptively;
- capability serialization originally downgraded module-load and graph-only helper
  failures to null metadata, so live inspect, plan, type generation, MCP inspection,
  and verification now fail closed while retaining the original module or API name;
- an attempted opaque binding sentinel could not intercept Boolean checks, `typeof`, or
  strict equality and could therefore corrupt env-dependent graph metadata, so binding
  property reads now fail closed and the required request-time access pattern is explicit;
- live API graph reads originally inferred method metadata from source after a module
  initialization error, so CLI inspection, planning, MCP, and verification are strict
  while the development banner keeps its explicitly side-effect-free static analysis;
- API discovery treated `src/api/*.d.ts` declarations as executable `/api/*.d` routes,
  so registries, runtime normalization, CLI discovery, graph tools, and dependency
  scanning now exclude declaration files consistently;
- resolving API re-exports by importing application modules executed their top-level
  code during startup, so export discovery is now side-effect-free static analysis;
- one pnpm policy shape was invalid on pnpm 10 and the example scripts used POSIX-only
  environment syntax, so both paths are version- and platform-aware;
- generated route registration types leaked into framework-internal navigation
  implementations, so those internals now use an explicitly untyped route target while
  public generated call sites retain their narrowing;
- fixed Playwright ports, Cloudflare inspector ports, and shared Wrangler persistence
  made independent test runs collide, so each suite atomically leases its own port block,
  selects an explicit inspector port, and disables or isolates local binding state;
- Playwright's global teardown runs before its managed web servers stop, so lease release
  is attached to the owning config process's exit and guarded by an ownership token;
- malformed lease owners could route zero, negative, fractional, or unsafe PIDs into
  liveness checks, so only positive safe-integer PIDs are accepted and invalid leases are
  reclaimed without signalling an unrelated process;
- concurrent suites still shared Vite optimizer state and mutated canonical example build
  output in place, so dev servers receive disposable cache directories and run from
  suite-private example copies beneath the lease, while production-build specs use
  per-test disposable copies under the repository's `.tmp` directory;
- copied fixtures and adapter builds could survive interrupted or failed runs, so child
  exits, signals, spawn failures, and suite-owner exit all use token-safe cleanup paths;
- a filesystem lease alone did not prove that unrelated host processes had left its
  ports free, so automatic allocation probes the complete candidate block and skips an
  occupied one while an explicit block fails with the unavailable ports and socket errors;
- production-build smoke tests initially replaced fixed ports with a bind-to-port-zero
  probe, but releasing that socket before spawning the server let simultaneous workers
  choose the same port, so each worker now holds a tokenized filesystem claim inside its
  suite block until the corresponding listener stops;
- concurrent global setup could publish a partially written shared `.tmp/tsconfig.json`
  bridge for disposable build fixtures, so setup now creates one complete immutable file
  through atomic hard-link publication and validates any bridge another suite won first.

Documentation review additionally corrected environment precedence, the Cloudflare
example's local secret name, runnable alternate-Wrangler-config instructions, Vercel's
build-time token scope, ignored secret-file patterns, and stale example claims.

### Remediation concurrency evidence

After isolating ports, optimizer caches, example copies, adapter output, and local Worker
state, two concurrent full Playwright suites passed independently (`123/123` and
`123/123`). Two concurrent signed-agent development runs also passed independently
(`1/1` and `1/1`). Focused follow-up runs passed the adapter build matrix (`3/3`), islands
HMR (`7/7`), and CLI development tests (`4/4`). A cleanup audit after those runs found no
leaked suite lease directories, Vite caches, adapter temporary projects, or HMR edits in
the canonical example sources.

The final workspace passed the repository's required `pnpm run verify` gate, including
the build, formatting, lint, generated-type freshness, generated-type compilation,
workspace typecheck, unit-test, and Playwright E2E stages. Three independent adversarial
review scopes then confirmed the exact tree with no remaining actionable runtime/API,
documentation/adoption, or test/concurrency findings.

## Findings

Severity is based on adoption impact and the likelihood that a user will mistake the
failure for their own application bug.

### F-01 — Cloudflare graph commands do not terminate on the repository lockfile

**Severity:** High

**Category:** CLI/runtime bug

`pracht inspect build --json` and `pracht plan --json` produce complete, valid output
for a Cloudflare application and then keep the process alive. This reproduced in both
`examples/basic` with the Cloudflare adapter and `examples/cloudflare`; each process
still needed an interrupt after 5–30 seconds.

A freshly generated Cloudflare project using `@cloudflare/vite-plugin@1.51.1` exits
normally. The repository lockfile currently resolves `@cloudflare/vite-plugin@1.31.1`
with Vite `8.0.3`, so this looks like an integration teardown problem on the versions
used by current `main`, rather than a universal CLI defect.

**Impact:** scripts, CI jobs, editor integrations, and parallel agents can hang after
receiving apparently successful output.

**Suggested action:** add an exit assertion to Cloudflare CLI integration tests and
either fix the teardown path or update/constrain the affected plugin combination.

### F-02 — The canonical basic example's generated route types are stale

**Severity:** High

**Category:** Example/docs gap and generated API drift

Both of these checks fail:

```sh
PRACHT_ADAPTER=node pnpm exec pracht typegen --check --json
PRACHT_ADAPTER=cloudflare pnpm exec pracht typegen --check --json
```

The reported stale/missing files are:

- `src/pracht.d.ts`;
- `src/pracht-routes.ts`;
- `src/pracht-capabilities.d.ts`.

Regeneration also changes the tracked capability declarations so `notes.search` and
`notes.create` are MCP-enabled. The example therefore advertises generated types that
do not describe its current routes and transports. Its package scripts do not expose a
typegen freshness check, and `pracht verify` does not catch this drift.

**Impact:** the main example can teach incorrect generated contracts and allows route
changes to merge without updating the agent-facing API surface.

**Suggested action:** regenerate the files and add `pracht typegen --check` to the
example's verification path.

### F-03 — The Cloudflare example gives incorrect Queue export guidance

**Severity:** High

**Category:** Documentation/API guidance bug

`examples/cloudflare/README.md` tells users to re-export Durable Objects, Workflows,
or Queues from `src/cloudflare.ts` using `workerExportsFrom`. Durable Objects and
Workflow classes are named exports, but Queue consumers are methods on the Worker's
default export. Pracht exposes `workerHandlersFrom` for those handlers.

The public `examples/docs` adapter page does not document `workerHandlersFrom`, even
though the root adapter reference does.

**Impact:** a user following the example can build a Queue producer while silently
failing to install the Queue consumer handler.

**Suggested action:** split named bindings (`workerExportsFrom`) from default handlers
(`workerHandlersFrom`) in the example and public adapter guide, with a Queue consumer
example.

### F-04 — Cloudflare and Vercel starters are blocked by pnpm 11 build-script approval

**Severity:** High

**Category:** Adoption footgun

Fresh generated Cloudflare and Vercel projects install dependencies but pnpm 11 exits
with `ERR_PNPM_IGNORED_BUILDS`. Cloudflare reports ignored builds for `esbuild` and
`workerd`; Vercel reports `esbuild`. A subsequent `pnpm run build` remains blocked
until the user runs:

```sh
pnpm approve-builds --all
```

After approval, all tested projects build. Node starters do not hit this problem.
Generated READMEs say to run `pnpm install` but neither seed an approval policy nor
explain the recovery command.

**Impact:** two of three advertised deployment starters fail on the default happy path
for pnpm users, with an error that appears unrelated to Pracht.

**Suggested action:** generate an explicit pnpm build policy for required packages, or
document and automate a narrowly scoped approval flow.

### F-05 — Concurrent graph inspection can race Vite's dependency cache

**Severity:** Medium

**Category:** Tooling concurrency bug

Running Node, Cloudflare, and Vercel graph inspection concurrently in one application
caused one Vercel process to fail while renaming a Vite dependency cache directory:

```text
ENOTEMPTY ... node_modules/.vite/deps_temp_* -> node_modules/.vite/deps
```

The same inspection passed when run serially. This can happen in CI matrices and is
especially likely when several local agents inspect the same workspace.

**Suggested action:** isolate or disable the Vite optimizer for read-only graph
commands, or serialize cache initialization with a workspace lock.

### F-06 — Public adapter and deployment docs lag important runtime behavior

**Severity:** Medium

**Category:** Documentation gap

The root references are substantially more complete than `examples/docs`. Notable
public-site omissions or errors are:

- the deployment introduction says only Node supports runtime ISG revalidation, while
  Cloudflare and Vercel also support runtime/native revalidation;
- Node options `canonicalOrigin`, `trustProxy`, and `maxBodySize` are absent, despite
  their security and proxy implications;
- Cloudflare cache-key query cardinality, trailing-slash behavior,
  `staleWhileRevalidate`, and Worker binding/handler distinctions are absent;
- Vercel's deliberate preview limitation, `functionName`,
  `createVercelNodeListener`, and build-time revalidation-token behavior are absent;
- Cloudflare's production-style trailing slash redirects are documented in the root
  reference but not the public site.

The Node production probe also demonstrated why `canonicalOrigin` matters: without it,
the server warns that request URLs are Host-derived.

**Suggested action:** make the public adapter pages a curated projection of
`docs/ADAPTERS.md` and add a parity check or shared content source.

### F-07 — A Cloudflare custom-domain route changes local preview request authority

**Severity:** Medium

**Category:** Deployment/adoption footgun

With the checked-in custom-domain route, Cloudflare preview advertises a localhost URL,
but inside the Worker `request.url` uses the configured custom domain. Signature
headers arrive unchanged; the mismatch is the HTTP Message Signature `@authority`.
Signing `localhost:<port>` is therefore treated as unsigned, while signing the custom
domain verifies successfully.

This affects Web Bot Auth and can also affect absolute redirects or any application
logic based on request origin. No current guide warns that the visible preview URL and
Worker request authority can differ when a custom route is configured.

**Suggested action:** document the behavior in the Cloudflare preview/Web Bot Auth
guides and consider printing the effective Worker authority in preview diagnostics.

### F-08 — The public CLI reference omits five shipped commands

**Severity:** Medium

**Category:** Documentation gap

The CLI ships 13 top-level commands:

`build`, `dev`, `doctor`, `eval`, `generate`, `inspect`, `llms`, `mcp`, `plan`,
`preview`, `report`, `typegen`, and `verify`.

The public CLI page has dedicated sections for only eight. `inspect`, `verify`, `eval`,
`mcp`, and `preview` are missing as command references even though they are central to
agent discovery, evaluation, and deployment workflows.

**Suggested action:** add syntax, exit behavior, machine-readable output, and adapter
constraints for every shipped command.

### F-09 — The Cloudflare dev endpoint table loses methods across re-exports

**Severity:** Medium

**Category:** Developer tooling/API visibility bug

The Cloudflare dev banner correctly reports methods for direct route modules, but API
modules mirrored through re-exports show `-` instead of methods. Runtime routing and
`pracht inspect` resolve the same routes correctly.

**Impact:** the startup summary implies that valid API endpoints have no callable
methods, weakening the banner as a debugging and agent-discovery tool.

**Suggested action:** use the same resolved route metadata for the banner and graph
inspection rather than separate static re-export analysis.

### F-10 — Local Cloudflare confirmation secrets require an undocumented `.dev.vars`

**Severity:** Medium

**Category:** Documentation/workflow footgun

Prefixing `pracht preview` with `PRACHT_CONFIRMATION_SECRET=...` does not inject that
host environment variable into the Worker. The destructive evaluation then fails with
`403 confirmation_unavailable`. Supplying the same secret through a local `.dev.vars`
file makes the full prepare/commit scenario pass.

The root environment material mentions platform environment configuration, and a skill
mentions `.dev.vars`, but the basic example only shows deployed `wrangler secret put`.

**Suggested action:** document a safe, ignored `.dev.vars` workflow beside the local
Cloudflare preview instructions and explain that shell-prefixed host variables are not
Worker bindings.

### F-11 — Showcase verification and report use inconsistent secret setup

**Severity:** Low

**Category:** Example workflow footgun

`examples/showcase` makes `pnpm run verify` self-contained by supplying a fallback
confirmation secret. Running `pracht report` directly does not use that package-script
setup, so its embedded verification section is red unless the operator separately
exports the secret. The showcase has no report script to preserve its verification
contract.

**Suggested action:** add a package `report` script that uses the same environment
setup, or teach the report command how to invoke the project's declared verification
workflow.

### F-12 — Successful builds emit alarming non-fatal warnings

**Severity:** Low

**Category:** Adoption friction

Canonical builds succeed but can emit warnings including an ineffective dynamic import
from the Node MCP runtime and automatic externalization of `node:module` in edge builds
on the repository's locked Vite/Cloudflare versions. The generated projects on newer
resolved edge tooling did not reproduce the latter warning.

**Impact:** users cannot easily distinguish known bundler noise from an invalid edge
bundle.

**Suggested action:** remove or suppress warnings that are known-safe, and add an
integration assertion that the externalized module is unreachable in edge execution.

## Confirmed behavior and intentional limitations

The following behaved as documented and should not be treated as defects:

- Vercel intentionally rejects `pracht preview` because Pracht cannot faithfully
  reproduce the deployed runtime; its error points to `vercel build`, `vercel dev`, and
  prebuilt deployment.
- Node and Vercel WebSockets are not available through the current adapter contracts.
- The pages router capability convention and capability generator are future work.
- Remote MCP currently omits resources, prompts, OAuth, and streaming transports.
- Destructive capabilities are deliberately unavailable through WebMCP and MCP; they
  require the confirmation-aware HTTP path.
- MCP Apps UI is not part of the current implementation.
- Cloudflare cache locality and query-cardinality constraints are platform properties
  already described in the root adapter reference.

## Recommended order of work

1. Fix the non-terminating Cloudflare graph commands and add process-exit coverage.
2. Regenerate and enforce the canonical example's route/capability declarations.
3. Correct Queue handler guidance and make generated pnpm projects install cleanly.
4. Close the public adapter/deployment/CLI reference gaps.
5. Isolate graph tooling from shared Vite optimizer state.
6. Improve Cloudflare preview diagnostics for bindings, authority, and re-exported
   methods.
7. Remove the remaining example-script and warning noise.

## Reproduction notes

The high-value commands used during this audit included:

```sh
pnpm run build
CI=1 pnpm run e2e
PRACHT_ADAPTER=node pnpm --dir examples/basic run build
PRACHT_ADAPTER=cloudflare pnpm --dir examples/basic run build
PRACHT_ADAPTER=vercel pnpm --dir examples/basic run build
pnpm exec pracht eval --url http://localhost:<port>
pnpm exec pracht inspect build --json
pnpm exec pracht plan --json
pnpm exec pracht typegen --check --json
pnpm approve-builds --all
```

Temporary diagnostic routes, secrets, and generated type files used to isolate the
findings were removed or reverted after testing.
