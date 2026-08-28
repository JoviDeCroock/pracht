# @pracht/capabilities

## 0.3.0

### Minor Changes

- [#344](https://github.com/JoviDeCroock/pracht/pull/344) [`3b0fdf7`](https://github.com/JoviDeCroock/pracht/commit/3b0fdf74944fb4db70ad7006678c05ca3b596be8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Serve `destructive` capabilities over remote MCP with `agents: { mcp: { destructive: true } }`, and ship `createSqlApprovalStore()` as the first durable approval store.
  
  The opt-in keeps the server-verified prepare/commit gate, requires a durable approval store and a valid identity source in human mode, and carries confirmation tokens in MCP `_meta`. Without it, destructive MCP declarations stay unserved. Inspection loads applied setup middleware, preserves effective MCP status in capability and agent reports, and confines confirmed composition to the active request. Updated starter skills document the new transport contract.

- [#341](https://github.com/JoviDeCroock/pracht/pull/341) [`7ae02fe`](https://github.com/JoviDeCroock/pracht/commit/7ae02feeb2a46dcba8457c861015b48680c6a388) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - `pracht eval` scenarios can now run over the remote MCP transport with `"transport": "mcp"`.
  
  A scenario that opts in performs a real `initialize` handshake against the app's
  MCP endpoint (`/mcp`, or `"mcpPath"`) and issues every step as a `tools/call`
  with the projected tool name, so an `expose.mcp` capability is proven the way an
  MCP host reaches it. Expectations stay portable between transports: `ok` mirrors
  `isError`, `output` matches `structuredContent`, `errorCode` reads the
  projection's error metadata, and `status` is the capability dispatch status
  (read from the projection's status metadata, not the JSON-RPC POST, which is 200
  for every answered call). `signAs` signs the JSON-RPC POSTs, so an
  `agentPolicy: "require"` capability is provable over MCP too.
  
  Three MCP limits fail the scenario with an explanation instead of passing
  quietly: a capability the endpoint does not project, a step header other than
  `authorization` (the projection forwards nothing else), and the destructive
  confirmation flow — destructive capabilities cannot be served over MCP today, so
  no MCP tool can answer `confirmation_required`; `confirm` is wired to the
  `tools/call` `_meta` for when that opt-in lands. The default stays `"http"`;
  existing scenarios are unchanged.

- [#351](https://github.com/JoviDeCroock/pracht/pull/351) [`0e7da8a`](https://github.com/JoviDeCroock/pracht/commit/0e7da8a2339b3583c6e8c4d67fc22a969b3b816c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Align the WebMCP projection with the current spec and its shipping hosts (ChatGPT desktop browser, Chrome/Edge origin trial).
  
  Page tools now resolve `execute()` to the capability envelope as a plain value — the host serializes it per the spec — instead of MCP-style content blocks, which reached agents double-encoded. Descriptors gain the capability `title`, the remote MCP projection's effect-derived hint set (`readOnlyHint`/`destructiveHint`/`idempotentHint`), and, via the new `expose.webmcp: { untrustedContent: true }` options form, the `untrustedContentHint` annotation. The shim targets `document.modelContext` only: the getter landed in Chromium 150 and the deprecated `navigator.modelContext` alias was removed in 152, so pre-150 origin-trial builds are no longer targeted. Names outside the WebMCP tool-name grammar are rejected at registry resolution and by `pracht verify`, which also warns when a page tool sits behind an effective `agentPolicy: "require"` (unsigned page fetches always 401) and when tool or parameter descriptions exceed the published agent-legibility budgets. Type note: the exported `CapabilityExposure` and `CapabilityProjection` shapes gained required `webmcpUntrustedContent` (and `title` on the projection) fields — code constructing these objects by hand needs the new fields.

## 0.2.0

### Minor Changes

- [#275](https://github.com/JoviDeCroock/pracht/pull/275) [`e0bd8a9`](https://github.com/JoviDeCroock/pracht/commit/e0bd8a928f8248664859d8ea0d9a9c78ae76e815) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Harden remote MCP capability composition, verified agent identity, and audit
  attribution.
  
  `CapabilityAuditEvent` gains `via`, which attributes server-side composition to
  the trusted HTTP or MCP request that caused it. Audit hooks receive immutable
  event and identity snapshots, including through request-local callbacks.
  
  MCP-originated `invokeCapability()` calls now re-apply the callee's
  `agentPolicy` and reject destructive effects before middleware or capability
  code can run. Trusted MCP provenance is bound to both the incoming transport
  request and the synthesized capability request, so adapter contexts that retain
  either request cannot escape the nested-call guard. Private non-destructive
  composition and named middleware remain available.
  
  Verified Web Bot Auth identity is exposed as a read-only immutable snapshot on
  request contexts, capability hosts, audit events, and test hosts. Binding that
  identity to frozen or sealed ordinary application contexts preserves their
  receivers, private fields, array branding, callable construction and property
  surfaces, reflection behavior, and writable source fields, including live
  descriptors, prototype changes made through another retained reference, and
  overlays frozen after retained source updates. Application-defined
  `Symbol.toStringTag` brands do not change whether an ordinary context can be
  overlaid. Immutable native built-ins, including platform globals and
  cross-realm instances, fail closed based on their actual prototypes because an
  overlay cannot preserve their internal slots; wrap them in a fresh mutable
  request-context object. Reusing a context across different
  verified identities fails closed, including when immutable contexts require an
  overlay, and reflected methods and accessors preserve their original
  private-field receivers across integrity operations. Receiver-bound helpers on
  immutable contexts continue to observe the original object, so apps that need
  helpers to read `agent` or middleware-added state should supply a mutable
  per-request context. Every one of these fail-closed cases is delivered as a
  response — a 500 from `handlePrachtRequest()`, an `internal_error` envelope from
  `invokeCapability()` — never as a rejection out of the adapter. HTTP and MCP
  composition retain the transport-verified identity even when application code
  supplies a replacement context object to `invokeCapability()`.

- [#264](https://github.com/JoviDeCroock/pracht/pull/264) [`7de4718`](https://github.com/JoviDeCroock/pracht/commit/7de4718761cb2fe1427f1a3c5ece8ffe6f2a1778) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add a durable approval store for destructive capabilities.
  
  The stateless prepare/commit flow proves a commit is bound to one principal,
  one capability, and one exact input — but a captured token replays until it
  expires, and the calling agent can hand its own token straight back to itself.
  
  `setCapabilityApprovalStore()` closes the replay gap. Prepare records a
  proposal (keyed by a secret-derived digest of principal + capability + input +
  approval mode, so repeated prepares address one proposal without exposing
  low-entropy principals); commit verifies the HMAC first, then consumes the
  proposal exactly once. Store-backed tokens use a distinct version and bind the
  approval mode, so rolling deployments fail closed on older or differently
  configured replicas. `agents.confirmation.mode: "human"` also closes the
  self-approval gap by refusing the commit with `confirmation_pending` until a
  person approves out of band.
  `setCapabilityApprovalPrincipalResolver()` binds proposals to an
  application-authenticated user or tenant; human mode fails closed without that
  identity or a verified Web Bot Auth agent. `createMemoryApprovalStore()` ships
  as the reference implementation for tests, development, and single-instance
  deployments. Durable implementations must atomically insert proposals and
  compare-and-set consumption so concurrent prepares cannot resurrect a commit;
  consumed and rejected proposals stay closed until their TTL expires.
  
  The caller interaction is unchanged: callers still just echo the confirmation
  token. `CapabilityErrorCode` gains `confirmation_pending`, and the error
  payload gains an optional `approvalId`.

- [#265](https://github.com/JoviDeCroock/pracht/pull/265) [`24f412a`](https://github.com/JoviDeCroock/pracht/commit/24f412adaa6f790f6896a554ed6e180151fb5cfe) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Serve capabilities as remote MCP tools over stateless Streamable HTTP.
  
  `defineApp({ agents: { mcp: {} } })` opens one endpoint (default `/mcp`)
  projecting every capability that sets `expose.mcp` as an MCP tool. It is a
  transport adapter, not a second pipeline: `tools/call` synthesizes the request
  the HTTP projection would have received and calls the same dispatch, so input
  validation, named middleware, `agentPolicy`, output validation, and audit
  events are identical across HTTP, WebMCP, and MCP by construction. No MCP SDK
  dependency.
  
  `expose.mcp` does not require `expose.http`, so a capability can be reachable
  by remote agents without a public browser endpoint. Dotted capability names map
  to underscored tool names (`notes.search` → `notes_search`); collisions are a
  `pracht verify` error and the runtime refuses to serve an ambiguous tool list.
  Projected names beyond the 64-character host limit are rejected by verification
  and the runtime as well. Accepted JSON-RPC requests keep protocol errors on HTTP
  200 so Streamable HTTP clients can parse the structured error response.
  Cookie-bearing and browser-originated requests are rejected before capability
  dispatch, `Authorization` is forwarded, and destructive capabilities stay off
  the MCP surface. Rejecting `Origin` and `Sec-Fetch-Site` avoids trusting a
  Host-derived request URL and closes the DNS-rebinding path. Error results keep
  machine-readable details in `_meta` instead of off-schema `structuredContent`.
  The endpoint supports the `2025-11-25` and `2025-06-18` protocol profiles;
  MCP-exposed input and output schemas must be object-rooted until the complete
  `2026-07-28` wire codec ships.
  
  `CapabilityAuditEvent.transport` gains `"mcp"`, `AppGraph` gains
  `mcpEndpoint`, and `pracht dev` prints the endpoint next to the capability
  table (`mcp(unserved)` when `expose.mcp` is declared but no endpoint is
  configured).
  
  MCP audit attribution is internal dispatch state rather than a client-set
  header. A configured endpoint remains protocol-active with an empty graph and
  returns JSON-RPC errors when registry resolution fails. Custom endpoint paths
  are validated as exact same-origin pathnames and accept one trailing slash.
  Malformed non-object `tools/call.arguments` are rejected as JSON-RPC invalid
  params before capability dispatch. App-graph snapshots record MCP endpoint
  activation, moves, and removal, with activation flagged as an agent-surface
  widening by `pracht plan`.
  
  Capability HTTP paths may not collide with the configured MCP endpoint, and
  malformed `initialize` parameters now return JSON-RPC invalid params. MCP tool
  annotations also leave `destructiveHint` unset for `write` capabilities because
  the write effect alone does not prove an operation is purely additive.
  Middleware-produced success envelopes are revalidated against the advertised
  output schema before their data is returned as MCP `structuredContent` and
  before the audit outcome and status are finalized.
  Synthesized MCP requests retain the request-bound capability host, so named
  middleware and capability bodies can compose registered capabilities through
  `invokeCapability()` without losing the active application registry.

### Patch Changes

- [#276](https://github.com/JoviDeCroock/pracht/pull/276) [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Drop the agent surface from server bundles that do not use it.
  
  `handlePrachtRequest` statically imported the capability dispatch and the Web Bot
  Auth verifier, so every app shipped them whether or not it registered a
  capability or configured `agents` — about 15 KB gzip (a third) of an
  islands-example server bundle.
  
  Both now load on demand, and the vite plugin defines `__PRACHT_AGENT_SURFACE__`
  as `false` for builds whose manifest provably registers neither, which lets the
  bundler eliminate them outright even when `llmsTxt` indexes pages and API
  routes. The analysis is deliberately one-sided: an
  unreadable or non-literal manifest, a parse failure, a spread, a shorthand
  registration, a computed key, or opaque syntax such as a regular-expression
  literal keeps the runtime, and a build that elided the runtime while capabilities
  are registered logs a loud error instead of 404ing quietly. Dev builds always
  keep the runtime so a freshly added capability works without a restart. Escaped
  quoted property names are decoded by the shared static scanner, while escaped
  identifier keys conservatively keep the runtime.

- [#271](https://github.com/JoviDeCroock/pracht/pull/271) [`eb6bd81`](https://github.com/JoviDeCroock/pracht/commit/eb6bd81a757fe697edf04d73570245979de6ce04) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Map capability middleware responses with status 429 to the typed
  `rate_limited` error code across HTTP, MCP, generated clients, and direct server
  invocation while preserving the middleware's `Retry-After` response header.

## 0.1.1

### Patch Changes

- [#253](https://github.com/JoviDeCroock/pracht/pull/253) [`06da850`](https://github.com/JoviDeCroock/pracht/commit/06da850b103bc259ae25bd8c0de79a7ab8e409a0) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Give the capability projection rules one home, and cross-check them in typegen.

  The HTTP path, effect, WebMCP exposure, and input schema of a capability were
  derived twice: once by the Vite plugin's static analysis (capability modules
  must never enter the client graph, so it cannot execute them) and once by the
  app graph, which loads the modules. Both now share
  `extractCapabilityProjection` from `@pracht/capabilities/static`.

  `pracht typegen` cross-checks the executed graph against that static pass and
  fails when they disagree — including when static analysis cannot read an exposed
  capability at all, which is what a computed `expose` or `effect` looks like.
  Without the check, generated types could describe an endpoint the client bundle
  never registers.

## 0.1.0

### Minor Changes

- [#211](https://github.com/JoviDeCroock/pracht/pull/211) [`82286b3`](https://github.com/JoviDeCroock/pracht/commit/82286b3a86e708c11e7287b9251ee62bf9cc0ae3) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - The capability graph: define a typed application operation once and project it to every surface — server code, a generated HTTP endpoint, WebMCP page tools for in-browser agents, the human UI, and llms.txt discovery — with a built-in agent trust layer. See docs/CAPABILITIES.md, docs/AGENT_TRUST.md, docs/LLMS_TXT.md, and the decision log in docs/CAPABILITY_GRAPH.md.

  **Capability core.** The new `@pracht/capabilities` package provides `defineCapability()`: a protocol-neutral operation with a dependency-free JSON Schema subset validator (unsupported keywords are rejected at definition time so they can never silently widen an exposed contract), effect classes (`read`/`write`/`destructive`), named middleware, and explicit exposure. Capabilities register in the app manifest via `defineApp({ capabilities: { ... } })` and are private by default. The package is also the single home of the wire protocol — `capabilityHttpPath()`, the confirmation and transport header names, the `CapabilityErrorCode` union, the envelope types, the schema→TypeScript printer, and the shared static extractor (`@pracht/capabilities/static`) — consumed by the framework, the Vite plugin, and the CLI so the contract cannot drift between packages. Static extraction masks regex literals during entry-point discovery, including regex expression statements after control-flow conditions, and accepts ECMAScript code-point escapes based on their numeric range rather than a fixed digit count.

  Capability validation also enforces the JSON data model at every boundary, including unconstrained/additional properties and schema `const`, `default`, and `enum` values, and applies JSON Schema string lengths by Unicode code point, so multipart files, prototype-named fields, astral Unicode characters, and other JavaScript-only values cannot bypass or distort validation and destructive-call confirmation bindings.

  The shared static extractor used by browser codegen and `pracht verify` ignores comments, string contents, and regex literals when locating capability definitions and registrations, parses both fixed-width and code-point Unicode escapes in inline literals, analyzes the module's default-exported capability, and scopes manifest extraction to the exported `defineApp()` configuration — so examples, commented-out code, or a helper capability defined earlier in the file cannot change the generated capability surface.

  **Projections.** `@pracht/core` resolves the registry and runs one dispatch pipeline (input validation → named middleware → `run()` → output validation) behind every surface: request-scoped `invokeCapability()` for direct server use (loaders, API routes, middleware), `POST /api/capabilities/<name>` with a typed `{ ok, data | error }` envelope, CSRF protection, and production redaction (custom HTTP paths that URL parsing could reinterpret as cross-origin or as a different pathname are rejected), and — via `@pracht/vite-plugin` — the generated `virtual:pracht/capabilities` browser client (`callCapability()`, with `confirm` sugar for confirmation tokens) and `virtual:pracht/webmcp`, a feature-detected WebMCP page-tool shim (`document.modelContext.registerTool`, Chrome origin trial). Direct invocation hosts are bound to their incoming `Request`, so overlapping apps or dev-server generations cannot route a call through another registry. Both virtual modules cost zero bytes when unused.

  **One contract for humans and agents.** `<Form capability="notes.create">` posts the framework's form component straight to the capability endpoint agents call: fields are coerced onto the input schema server-side, `onCapabilityResult` receives the typed envelope, and without JavaScript the endpoint accepts the form-encoded post and answers a successful document submission with a 303 back to the same-origin referring page. Enhanced submissions honor a clicked submitter's `formaction` and follow middleware redirects to their final browser URL, matching that no-JavaScript behavior: a redirect is handed back to the same-origin fetch as a readable target (with relative `Location` values resolved against the endpoint) and the browser navigates itself, so an external OAuth/SSO destination is never fetched through CORS and never submitted twice, and a cross-origin form target falls back to a native document submission (after client-side schema validation, if any). Effect classes drive the client cache: after any successful non-`read` browser call (`callCapability()` or `<Form capability>`) the active route's loader data revalidates automatically — a full reload under islands hydration — and `revalidate: false` opts out per call.

  **Agent trust layer.** Web Bot Auth verification (RFC 9421 HTTP Message Signatures, Ed25519 via WebCrypto, static keys or allowlisted `/.well-known/http-message-signatures-directory` JWKS lookups — fail closed everywhere) opts in via `defineApp({ agents: { webBotAuth } })` and surfaces the verified identity as `context.agent` — now typed end to end (`CapabilityContext`, `PrachtRequestContext`) with `"observe"`/`"require"` policies and per-capability `agentPolicy` overrides. Destructive capabilities may expose over HTTP only, gated by a server-verified prepare/commit confirmation flow (`409 confirmation_required` + short-lived HMAC token bound to principal, capability, and canonical input; requires `PRACHT_CONFIRMATION_SECRET`). The gate runs inside the named middleware chain, so rate limiting sees prepare and invalid-token attempts too. Every dispatch emits a structured audit event (`setCapabilityAuditHook()` / `onCapabilityAudit`) whose transport distinguishes `http`, `server`, and `webmcp`.

  **Discovery & DX.** The opt-in `pracht({ llmsTxt })` option emits llms.txt (https://llmstxt.org) from the resolved app graph — pages, API endpoints, and HTTP-exposed capabilities with effect classes — written at build time and served live in dev; `create-pracht` templates enable it by default. `pracht typegen` emits `src/pracht-capabilities.d.ts` so `invokeCapability()`, `callCapability()`, `<Form capability>`, and the test host infer input/output types from the capability name. `pracht eval` runs scripted agent-task scenarios (with `$steps[n]` references and a `confirm` field for the confirmation flow) against a live app, `--start` managing the server lifecycle. `createCapabilityTestHost()` unit-tests the full pipeline including simulated agent identities. `pracht inspect capabilities`, the MCP `inspect_capabilities` tool, `/_pracht` devtools, and the dev banner all render the same graph — with declared-but-unserved `expose.mcp` labeled `mcp(unserved)` and warned about by `pracht verify` until the remote MCP projection ships.
