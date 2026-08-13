# @pracht/core

Core routing, rendering, server/client runtime, and type utilities for pracht.

## Install

```bash
npm install @pracht/core preact preact-render-to-string
```

## API

### Route Manifest

- `defineApp()` — define the application and its route tree
- `route()` — declare a route with path, component, loader, and rendering mode
- `group()` — group routes under a shared shell or middleware

Route modules may export the page as a function default export or as a named
`Component` export. Named exports such as `loader`, `head`, `ErrorBoundary`, and
`getStaticPaths` keep their special route-module behavior.

### Server

- `handlePrachtRequest()` — server renderer that produces full HTML with hydration markers
- `matchAppRoute()` — segment-based route matching

`handlePrachtRequest()` sanitizes unexpected 5xx errors by default so raw server
messages do not leak into SSR HTML or route-state JSON. Explicit
`PrachtHttpError` 4xx messages are preserved. Pass `debugErrors: true` to expose
raw details intentionally during debugging; the flag is ignored when
`NODE_ENV=production`. Debug responses also attach `error.diagnostics`
metadata for the failure phase and matched framework files when available.

For contributors, shared route-state JSON and redirect normalization lives in
`runtime-route-state-response.ts`, while `runtime-rendering.ts` owns lazy
loading of the Preact server renderer. API failure policy lives in
`runtime-api-error-response.ts`, route error-boundary HTML in
`runtime-route-error-response.ts`, and their shared generated-asset options in
`runtime-response-types.ts`; `runtime-response.ts` is the compatibility facade.
Server islands likewise keep registry, vnode interception, and marker rendering
in `islands-server.ts`, with strategy and JSON prop wire validation isolated in
`islands-serialization.ts` behind the existing public validator.

Capability transport keeps its request contract in the type-only
`runtime-capability-transport-types.ts`. MCP-only middleware output
revalidation lives in `runtime-capability-mcp-output.ts`, separate from the
ordinary request parsing, agent policy, form fallback, and pipeline dispatch in
`runtime-capability-http-dispatch.ts`. App-level API middleware wrapping lives
in `runtime-capability-api-middleware.ts`; `runtime-capabilities.ts` retains the
public facade, effect header, and one-event audit orchestration.

Direct capability composition follows the same focused layering:
`runtime-capability-invocation.ts` retains the stable typed overloads,
`runtime-capability-host.ts` owns request-local host binding,
`runtime-capability-composition.ts` owns nested MCP and trusted-context policy,
and `runtime-capability-invocation-dispatch.ts` owns pipeline execution and
auditing. Shared contracts live in `runtime-capability-invocation-types.ts` so
the policy and transport modules depend on types instead of the public facade.

The deployed remote MCP entry follows the same shape. `runtime-mcp.ts` is the
stable export and method-routing facade; `runtime-mcp-request.ts` owns
stateless transport hardening and JSON-RPC preparation, while
`runtime-mcp-tool-registry.ts` owns fail-closed tool-name validation. Protocol
primitives, result projection, and call execution stay isolated in the
existing `runtime-mcp-protocol.ts`, `runtime-mcp-tools.ts`, and
`runtime-mcp-dispatch.ts` modules.

Destructive confirmation keeps `runtime-confirmation.ts` as its stable facade
and secret-configuration boundary. Canonical input binding plus HMAC token
creation and verification live in `runtime-confirmation-token.ts`; the
best-effort per-instance replay cache lives in
`runtime-confirmation-replay.ts`. Durable proposal orchestration remains in
`runtime-capability-confirmation.ts`.

Enhanced form submission keeps `runtime-form.ts` as the public rendering and
event-flow facade. Native resubmission mechanics, ordinary API submission, and
capability submission live in `runtime-form-native.ts`, `runtime-api-form.ts`,
and `runtime-capability-form.ts` respectively.

Middleware helpers are similarly separated by responsibility:
`runtime-redirect.ts` owns safe redirect construction,
`runtime-middleware-chain.ts` owns ordered fail-closed execution, and
`runtime-document-metadata.ts` owns shell/route head and document-header
aggregation. `runtime-middleware.ts` remains the stable internal facade.

Portable response-header primitives live in `runtime-header-values.ts`:
user-provided value validation, header application, and `Vary` composition.
Security defaults and caching policy remain in `runtime-headers.ts`, which
continues to re-export the former helper surface.

The isolated `@pracht/core/agent-auth` entry keeps `agent-auth-sign.ts` as its
public facade. Signing contracts live in `agent-auth-sign-types.ts`, RFC 9421
request/header construction in `agent-auth-request-signing.ts`, and Ed25519 key
lifecycle in `agent-auth-key-pair.ts`.

### Client

- `startApp()` — client-side hydration and runtime
- `useLocation()` — access the current pathname and search string separately
- `useSearchParams()` — read the current query as a reactive, read-only `URLSearchParams`
- `useRouteData()` — access loader data inside a route component; pass a route
  id for fully typed data after `pracht typegen`, or a `typeof loader` generic
  otherwise
- `useRevalidate()` — trigger a revalidation of the current route's data
- `<Form>` — progressive enhancement form component

### Types

- `LoaderData<T>` — infer the return type of a loader
- `RouteLoaderData<TModule, TFallbackModule?>` — infer loader data from a route
  module type; used by `pracht typegen` to key loader data by route id
- `RouteComponentProps<T>` — props type for route components
- `LoaderArgs` — argument type passed to loaders

For framework contributors, `src/types.ts` is the stable aggregate rather than
the declaration owner. App models, route policy, navigation contracts, and
runtime module contracts live in focused sibling modules; `http-errors.ts` owns
the concrete `PrachtHttpError` and `notFound()` behavior.

Typed API validation follows the same rule: `api-validation.ts` is the stable
facade, `api-validation-types.ts` owns inference and public contracts,
`api-validated-handler.ts` owns `defineApi()` execution, `api-json-response.ts`
owns typed JSON responses, and `api-request-validation.ts` owns request parsing
plus Standard Schema diagnostics.

### App graph serialization

The graph helpers exported from `@pracht/core` and `@pracht/core/server` support
custom inspection and development tooling. `src/app-graph.ts` is their stable
composition facade: shared contracts live in `app-graph-types.ts`, and route,
API, and capability serialization live in focused `app-graph-*` modules.
Runtime and source-only API export detection remains in
`src/api-export-detection.ts` behind the same public exports. Its conservative
source scanner keeps `api-export-source-scan.ts` as the internal facade,
delegating offset-preserving JavaScript masking to
`api-export-source-lexical.ts` and callable-default inference to
`api-export-callable-source.ts`:

- `serializeAppRoutes()` serializes resolved page routes.
- `serializeApiRoutes()` loads API modules and reports their callable exports.
  Pass `{ strict: true }` to fail with the route path and source file when a
  module cannot initialize instead of falling back to source inference.
- `serializeApiRoutesStatic()` and `detectApiExportsStatic()` inspect API
  exports without executing application modules. Supply
  `AppGraphStaticModuleAccess`, including `resolveModule` when star re-exports
  should be followed. Static default handlers are reported only when local
  syntax establishes a callable value.
- `serializeCapabilities()` loads registered capability contracts. Pass
  `{ strict: true }` to fail with the capability name and source file when a
  contract cannot initialize; the non-strict form retains diagnostic fallback
  metadata for development surfaces.
- `buildAppGraph()` combines resolved routes, API routes, capabilities, and the
  remote MCP endpoint into the shared `AppGraph` shape.

Use the static API helpers for startup banners and other read-only surfaces
where importing an application module would run unrelated top-level work. Use
strict module loading for authoritative inspection, planning, and verification;
silently inferred or null metadata is not authoritative enough for those
workflows.

### llms.txt generation

`buildLlmsTxt()` remains the public builder in `src/llms-txt.ts`. Contributor
boundaries keep its public contracts in `llms-txt-types.ts`, graph-to-entry
collection in `llms-txt-entries.ts`, and fail-closed reserved-path plus user
exclusion policy in `llms-txt-exclusions.ts`. The facade owns deterministic
section rendering and output formatting.

## Rendering Modes

Each route can specify its rendering mode:

- `ssr` — server-rendered on every request
- `ssg` — pre-rendered at build time
- `isg` — pre-rendered with time-based revalidation
- `spa` — client-only route rendering with optional shell/loading HTML on first paint
