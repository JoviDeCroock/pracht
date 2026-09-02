---
title: API Reference
lead: Every export an application uses, grouped by what it does, with the guide that explains it. Look a symbol up here when you know the name but not the page.
breadcrumb: API Reference
prev:
  href: /docs/examples
  title: Examples
next:
  href: /docs/reference/config
  title: Configuration
---

## Import Paths

Almost everything comes from `@pracht/core`. The package declares a `browser`
condition, so a client bundle automatically resolves to a client-safe subset of
the same entry point — you do not pick a different specifier for the browser.

| Specifier | Use |
| --- | --- |
| `@pracht/core` | Application code, client and server alike |
| `@pracht/core/server` | Server-only entry points, mostly for adapters and generated server entries |
| `@pracht/core/client` | `initClientRouter()` and hydration state, for custom client entries |
| `virtual:pracht/capabilities` | The generated browser capability client. See [Capabilities](/docs/capabilities) |

Companion packages — `@pracht/i18n`, `@pracht/image`, `@pracht/content`,
`@pracht/markdown`, `@pracht/openapi`, `@pracht/test` — are separate installs
and are listed at the bottom of this page.

---

## Defining the App

| Export | Description |
| --- | --- |
| `defineApp(config)` | The route manifest. See [Configuration](/docs/reference/config#defineapp--the-route-manifest) |
| `route(path, file, meta?)` | One route. See [Routing](/docs/routing) |
| `group(meta, routes)` | Shared meta for a subtree of routes |
| `timeRevalidate(seconds)` | ISG time-based revalidation policy. See [Rendering Modes](/docs/rendering) |
| `webhookRevalidate()` | ISG on-demand revalidation policy |

### Constraints

Declarative invariants over the resolved graph, enforced by `pracht verify`.
See [Coding Agents](/docs/coding-agents#constraints).

| Export | Description |
| --- | --- |
| `requireMiddleware(pattern, name)` | Every matching route must run this middleware |
| `requireShell(pattern, name)` | Every matching route must use this shell |
| `requireRenderMode(pattern, mode)` | Every matching route must use this render mode |
| `forbidRenderMode(pattern, mode)` | No matching route may use this render mode |
| `requireHead(pattern)` | Every matching route must export `head()` |

---

## Components

| Export | Description |
| --- | --- |
| `<Link>` | Typed client-side navigation. See [Routing](/docs/routing#link-props) |
| `<Form>` | Progressive form submission to an API route or a capability. See [Forms](/docs/recipes/forms) |
| `<Script>` | Third-party scripts with a loading strategy. See [Data Loading](/docs/data-loading#third-party-scripts--script) |
| `<Suspense>`, `lazy()` | Code-split a subtree with a fallback. See [Rendering Modes](/docs/rendering) |
| `<ErrorBoundary>` | Catch render errors in a subtree. See [Data Loading](/docs/data-loading#scoping-a-boundary-to-a-subtree) |
| `forwardRef()` | Preact's `forwardRef`, re-exported so an app needs one Preact import path |

---

## Loader Data

| Export | Description |
| --- | --- |
| `defer(promise)` | Mark slow loader data for concurrent resolution. See [Data Loading](/docs/data-loading#deferred-values) |
| `use(value)` | Read a `Deferred<T>`, promise, or settled value inside `<Suspense>` |
| `Deferred<T>` | The typed marker returned by `defer()` |

---

## Hooks

| Export | Returns | Description |
| --- | --- | --- |
| `useRouteData()` | The loader's data | The active route's loader result. See [Data Loading](/docs/data-loading) |
| `useParams()` | `Record<string, string>` | Matched dynamic segments. See [Routing](/docs/routing#reading-params) |
| `useLocation()` | `{ pathname, search }` | The current URL as the visitor sees it, deploy base included |
| `useSearchParams()` | `ReadonlyURLSearchParams` | The query string, reactively. Mutating it throws — navigate instead |
| `useNavigate()` | `(to, options?) => Promise<void>` | Imperative navigation, by path or route object |
| `useNavigation()` | `{ state, location?, formData? }` | Pending state for the current navigation or `<Form>` submission: `"idle"`, `"loading"`, or `"submitting"` |
| `useBlocker(shouldBlock, options?)` | `{ state, location, proceed, reset }` | Stop a navigation before it commits — unsaved-changes guards. See [Data Loading](/docs/data-loading#useblocker) |
| `useRevalidate()` | `() => void` | Re-run the active route's loader |
| `useIsHydrated()` | `boolean` | `false` during SSR and the first client render, `true` after |
| `useEventSource(url, options?)` | `{ status, data, lastEventId }` | Subscribe to a server-sent event stream. `status` is `"connecting"`, `"open"`, or `"closed"`. See [Server-Sent Events & WebSockets](/docs/recipes/streaming) |
| `useCapability(name)` | `{ call, data, error, pending, reset }` | Call state for a user-triggered [capability](/docs/capabilities) call. From `virtual:pracht/capabilities` |

---

## Navigation

| Export | Description |
| --- | --- |
| `prefetch(target)` | Warm a route's chunks and route-state JSON. See [Prefetching](/docs/prefetching#imperative-prefetching) |
| `createHref(routes)` | Build an `href()` helper from route definitions. `pracht typegen` generates one for you |
| `buildHref(...)` | Resolve a route id and params to a URL path |
| `redirect(location, options?)` | Throw from a loader or middleware to redirect. See [Middleware](/docs/middleware) |
| `notFound(message?)` | Throw to render the app's 404 page. See [Data Loading](/docs/data-loading#custom-404-page) |
| `PrachtHttpError` | Throw for a structured error response with a status |

### Deploy base

For hand-written URLs only — `<Link>`, `href()`, and `apiFetch()` already apply
the base. See [Sub-Path Deploys](/docs/deployment#sub-path-deploys).

| Export | Description |
| --- | --- |
| `PRACHT_BASE` | The configured base, with leading and trailing slashes. `"/"` by default |
| `withBase(path)` | Route path → URL path |
| `stripBase(pathname)` | URL path → route path, or `null` when the URL is outside the base |

---

## API Routes

| Export | Description |
| --- | --- |
| `defineApi(config)` | Schema-validated handlers with typed args. See [API Validation](/docs/api-validation) |
| `json(value, init?)` | A typed JSON `Response` |
| `apiFetch(path, options?)` | Typed client for your own API routes |
| `ApiFetchError` | Thrown by `apiFetch()` on a non-2xx response |
| `formDataToRecord(formData)` | `FormData` → a plain record, arrays for repeated fields |
| `searchParamsToRecord(params)` | The same for `URLSearchParams` |
| `isApiValidationErrorBody(body)` | Narrow a response body to the standard validation-error shape |

---

## Streaming

See [Server-Sent Events & WebSockets](/docs/recipes/streaming).

| Export | Description |
| --- | --- |
| `createEventStream(init?)` | A server-sent events `Response` with a `send`/`close` handle |
| `serializeEventStreamMessage(message)` | Format one SSE frame by hand |
| `isUpgradeRequest(request)` | True for a WebSocket upgrade request |

---

## Capabilities and Agents

See [Capabilities](/docs/capabilities) and [Agent Trust](/docs/agent-trust).

| Export | Description |
| --- | --- |
| `invokeCapability(name, input, ctx)` | Trusted server-side call, including private capabilities |
| `createCapabilityTestHost(options?)` | Drive capabilities in tests without booting a server |
| `setCapabilityAuditHook(hook)` | Receive a structured event for every capability call (single slot) |
| `addCapabilityAuditListener(name, hook)` | Add a named audit sink alongside others; re-registering the name replaces it. Returns an unsubscribe |
| `setCapabilityApprovalStore(store)` | Persist approvals for the confirmation flow |
| `createMemoryApprovalStore(options?)` | An in-memory store, for development and tests |
| `setCapabilityApprovalPrincipalResolver(fn)` | Decide which principal an approval belongs to |
| `setCapabilityConfirmationSecret(secret)` | Sign confirmation tokens |
| `defineCapability(config)` | Define one capability. From `@pracht/capabilities` |

---

## Environment

See [Environment Variables](/docs/env).

| Export | Description |
| --- | --- |
| `publicEnv` | Public variables, safe in the client bundle |
| `PRACHT_PUBLIC_ENV_PREFIX` | The prefix that marks a variable public |
| `filterPublicEnv(env)` | Reduce an env object to its public entries |
| `serverEnv` | Server-only variables. From `@pracht/core/env/server` |
| `setServerEnv(env)` | Supply the server env from an adapter that has no `process.env` |

---

## Fonts

| Export | Description |
| --- | --- |
| `defineFont(options)` | Self-hosted font with preload and `font-display` handling. See [Fonts](/docs/fonts) |

---

## Companion Packages

| Package | Key exports | Guide |
| --- | --- | --- |
| `@pracht/i18n` | `defineI18n`, `createDictionaries`, `t`, `tPlural`, `interpolate`, `matchAcceptLanguage`, `parseAcceptLanguage` | [i18n Reference](/docs/reference/i18n) |
| `@pracht/image` | `Image`, `getImageProps` | [Images](/docs/images) |
| `@pracht/content` | `defineCollection`, `llmsTxtArtifacts`, `rawContentArtifacts`, `parseFrontmatter` | [Content Collections](/docs/content) |
| `@pracht/markdown` | `defineMarkdownCollection` | [Content Collections](/docs/content) |
| `@pracht/openapi` | `defineOpenApi`, `getOpenApiDescriptor` | [OpenAPI](/docs/openapi) |
| `@pracht/capabilities` | `defineCapability` | [Capabilities](/docs/capabilities) |
| `@pracht/test` | `createLoaderArgs`, `runMiddleware`, `createFormRequest`, `submitForm`, `readJson`, `readRedirect` | [Testing](/docs/recipes/testing) |

---

## Not Listed Here

`@pracht/core` also exports build-time and adapter-facing internals —
`handlePrachtRequest`, `prerenderApp`, `buildAppGraph`, `handleMcpRequest`, the
revalidation helpers, the app-graph serializers. They are public because
adapters and generated entries need them, not because applications do. If you
find yourself reaching for one, the corresponding [adapter](/docs/adapters) or
CLI command probably already does the job.
