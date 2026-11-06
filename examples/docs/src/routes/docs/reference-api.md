---
title: API reference
lead: Every export an app uses, grouped by task, with a link to the guide that explains it.
---

## Import paths

Import application code from `@pracht/core`. Every pracht package is ESM-only, so `tsc` needs `"moduleResolution": "bundler"` (or `"node16"`/`"nodenext"`); see [TypeScript settings pracht requires](/docs/getting-started#typescript-settings-pracht-requires).

| Specifier | Use |
| --- | --- |
| `@pracht/core` | Application code, client and server alike |
| `@pracht/core/server` | Server-only entry points: adapters, generated server entries, `createEventStream()`, approval stores |
| `@pracht/core/client` | `initClientRouter()` and `readHydrationState()`, for custom client entries |
| `@pracht/core/env/server` | `serverEnv` and `setServerEnv()`. Importing it from client code fails the build |
| `@pracht/core/agent-auth` | `signAgentRequest()`, `createAgentSignatureHeaders()`, `generateAgentKeyPair()`. See [Agent trust](/docs/agent-trust) |
| `virtual:pracht/capabilities` | The generated browser capability client. See [Capabilities](/docs/capabilities) |

Client code resolves `@pracht/core` through its `browser` condition to a client-safe subset, so a server-only export such as `handlePrachtRequest` is a compile error there. A custom client tsconfig needs the condition and the generated `src/**/*.d.ts` types:

```json [tsconfig.client.json]
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "customConditions": ["browser"]
  },
  "include": ["src/routes/**/*", "src/shells/**/*", "src/islands/**/*", "src/**/*.d.ts"]
}
```

Companion packages are separate installs; see [Companion packages](#companion-packages).

## Defining the app

| Export | Description |
| --- | --- |
| `defineApp(config)` | The route manifest. See [Configuration](/docs/reference/config#defineapp--the-route-manifest) |
| `route(path, file, meta?)` / `route(path, config)` | One route. `config` is `{ component, loader?, ...meta }`. See [Routing](/docs/routing) |
| `group(meta, routes)` | Shared meta for a subtree of routes |
| `timeRevalidate(seconds)` | ISG time-based revalidation policy. See [Rendering modes](/docs/rendering) |
| `webhookRevalidate()` | ISG on-demand revalidation policy |

### Constraints

Declare invariants over the resolved graph in `defineApp({ constraints })`; `pracht verify` reports every violation. See [Coding agents](/docs/coding-agents#constraints).

| Export | Description |
| --- | --- |
| `requireMiddleware(pattern, ...names)` | Every matching route runs all of these middleware |
| `requireShell(pattern, ...names)` | Every matching route uses one of these shells |
| `requireRenderMode(pattern, ...modes)` | Every matching route uses one of these render modes |
| `forbidRenderMode(pattern, ...modes)` | No matching route uses any of these render modes |
| `requireHead(pattern)` | Every matching route exports `head()`, directly or through its shell |

In a pattern, `*` matches one path segment and a trailing `**` matches the rest.

## Route module types

Type exports of `@pracht/core` for route, shell, middleware, and API modules.

| Type | Types |
| --- | --- |
| `LoaderArgs<TContext?>` | A `loader`'s argument: `request`, `url`, `params`, `context`, `signal`, `route`, `waitUntil`, `search`, and `root` |
| `BaseRouteArgs<TContext?>` | The fields every route function receives, without `search` and `root` |
| `RouteComponentProps<typeof loader>` | A route component's props: `data` (the loader's return value) and `params` |
| `HeadArgs<typeof loader>` | `head()`'s argument: the route args plus `data` |
| `HeadersArgs<typeof loader>` | `headers()`'s argument: the route args plus `data` |
| `HeadMetadata` | `head()`'s return value: `title`, `lang`, `meta`, `link`, `script`, `fonts` |
| `LoaderData<typeof loader>` | The awaited return type of a loader |
| `ShellProps` | A shell component's props: `children` |
| `ErrorBoundaryProps` | An `ErrorBoundary` export's props: `error`, with optional `status` and validation `issues` |
| `MiddlewareFn<TContext?>` | A middleware export: `(args, next) => Response \| Promise<Response>` |
| `MiddlewareArgs<TContext?>` | A middleware's first argument; `route` is the matched page or API route |
| `ApiRouteArgs<TContext?>` | An API route handler's argument |
| `ApiRouteHandler<TContext?>` | An API route method export: `(args) => Response \| Promise<Response>` |
| `RouteParams` | `Record<string, string>` |
| `RootProps<TState>` | The [app root](/docs/shells#the-app-root) component's props: `state` and `children` |
| `Register` | Interface to augment with your app's `context` type, so `TContext` defaults to it |

## Components

| Export | Description |
| --- | --- |
| `<Link>` | Typed client-side navigation. See [Routing](/docs/routing#link-props) |
| `<Form>` | Progressive form submission to an API route or a capability. See [Forms](/docs/recipes/forms) |
| `<Script>` | Third-party scripts with a loading strategy. See [Data loading](/docs/data-loading#third-party-scripts--script) |
| `<Suspense>`, `lazy()` | Code-split a subtree with a fallback. See [Rendering modes](/docs/rendering) |
| `<ErrorBoundary>` | Catch render errors in a subtree. See [Data loading](/docs/data-loading#scoping-a-boundary-to-a-subtree) |
| `forwardRef()` | Preact's `forwardRef`, re-exported |

## Loader data

| Export | Description |
| --- | --- |
| `defer(promise)` | Mark slow loader data for concurrent resolution. See [Data loading](/docs/data-loading#deferred-values) |
| `use(value)` | Read a `Deferred<T>`, promise, or settled value inside `<Suspense>` |
| `Deferred<T>` | The typed marker `defer()` returns |
| `SearchArgs<typeof search>` | Types `args.search` as the route's `search` schema output. See [Routing](/docs/routing#search-params) |

## Server islands

Components in `src/server-islands/` rendered per request inside cached pages. See [Server islands](/docs/server-islands).

| Export | Description |
| --- | --- |
| `export const serverIslands` | Route or shell module export listing the server islands it renders. The endpoint runs only listed ones |
| `useServerIslandData<typeof loader>()` | Inside a server island component: the value its `loader` returned |
| `ServerIslandLoaderArgs<TContext, TProps>` | A server island `loader`'s argument: the page's route args plus the island's `props`, which are untrusted input |
| `ServerIslandProps` | Intersect into a server island's props for the framework-owned `fallback` |
| `ServerIslandLoaderData<T>` | The type `useServerIslandData<T>()` resolves to |

## Hooks

| Export | Returns | Description |
| --- | --- | --- |
| `useRouteData(routeId?)` | The loader's data | The active route's loader result. Pass the route id to type it. See [Data loading](/docs/data-loading#useroutedata) |
| `useShellData(shell?)` | The shell loader's data, or `undefined` | The active shell's loader result, in the shell and its routes. Pass the shell name to type it. See [Shells](/docs/shells#shell-data) |
| `useParams()` | `Record<string, string>` | Matched dynamic segments. See [Routing](/docs/routing#reading-params) |
| `useLocation()` | `{ pathname, search }` | The current URL as the visitor sees it, deploy base included |
| `useSearchParams()` | `ReadonlyURLSearchParams` | The query string, reactively. Mutating it throws; use `useSetSearchParams()` |
| `useSetSearchParams()` | `(next, options?) => Promise<void>` | Navigate to the current page with a new query string. `options` is `{ replace?, preserveScroll? }`. See [Data loading](/docs/data-loading#usesetsearchparams) |
| `useSearch(routeId?)` | The parsed query | The active route's `search` schema output, or the raw query without one. See [Routing](/docs/routing#search-params) |
| `useNavigate()` | `(to, options?) => Promise<void>` | Imperative navigation, by path or route object |
| `useNavigation()` | `{ state, location?, formData? }` | Pending state for the current navigation or `<Form>` submission: `"idle"`, `"loading"`, or `"submitting"` |
| `useBlocker(shouldBlock, options?)` | `{ state, location, proceed, reset }` | Stop a navigation before it commits, e.g. on unsaved changes. See [Data loading](/docs/data-loading#useblocker) |
| `useRevalidate()` | `() => Promise<unknown>` | Re-run the active route's loader and its shell's |
| `useIsHydrated()` | `boolean` | `false` during SSR and the first client render, `true` after |
| `useEventSource(url, options?)` | `{ status, data, lastEventId }` | Subscribe to a server-sent event stream. `status` is `"connecting"`, `"open"`, or `"closed"`. See [Server-sent events and WebSockets](/docs/recipes/streaming) |
| `useWebVitals(reporter)` | `void` | Report CLS, FCP, INP, LCP, and TTFB from a client component. See [Performance](/docs/performance#real-user-web-vitals) |
| `useCapability(name)` | `{ call, data, error, pending, reset }` | Call state for a user-triggered [capability](/docs/capabilities) call. From `virtual:pracht/capabilities` |

## Navigation

| Export | Description |
| --- | --- |
| `prefetch(target)` | Warm a route's chunks and route-state JSON. Returns a promise. See [Prefetching](/docs/prefetching#imperative-prefetching) |
| `createHref(routes)` | Build an `href()` helper from route definitions. `pracht typegen` generates one for you |
| `buildHref(routes, routeId, options?)` | Resolve a route id and its params to a URL path |
| `redirect(location, options?)` | A redirect `Response`. Return or throw it from a loader, middleware, or API route; pass `{ request }` for method-aware 302/303. See [Middleware](/docs/middleware) |
| `notFound(message?)` | A 404 `PrachtHttpError`. Throw it to render the app's 404 page. See [Data loading](/docs/data-loading#custom-404-page) |
| `new PrachtHttpError(status, message)` | Throw for an error response with that status |

### Deploy base

Use these for hand-written URLs only; `<Link>`, `href()`, and `apiFetch()` already apply the base. See [Sub-path deploys](/docs/deployment#sub-path-deploys).

| Export | Description |
| --- | --- |
| `PRACHT_BASE` | The configured base, with leading and trailing slashes. `"/"` by default |
| `withBase(path)` | Route path → URL path |
| `stripBase(pathname)` | URL path → route path, or `null` when the URL is outside the base |

## API routes

| Export | Description |
| --- | --- |
| `defineApi(config)` | Schema-validated handlers with typed args. See [API validation](/docs/api-validation) |
| `json(value, init?)` | A typed JSON `Response` |
| `apiFetch(path, options?)` | Typed client for your own API routes |
| `ApiFetchError` | Thrown by `apiFetch()` on a non-2xx response. Carries `status`, `response`, `body`, and `issues` |
| `formDataToRecord(formData)` | `FormData` → a plain record, arrays for repeated fields |
| `searchParamsToRecord(params)` | The same for `URLSearchParams` |
| `isApiValidationErrorBody(body)` | Narrow a response body to the standard validation-error shape |

## Streaming

Import these from `@pracht/core/server`. See [Server-sent events and WebSockets](/docs/recipes/streaming).

| Export | Description |
| --- | --- |
| `createEventStream(request, init?)` | Returns `{ response, send, close, closed, desiredSize }`. Return `response` from an API route. `init` is `{ keepAlive?, headers? }`, with `keepAlive` in seconds |
| `serializeEventStreamMessage(message)` | Format one SSE frame by hand |
| `isUpgradeRequest(request)` | `true` for a WebSocket upgrade request |

## Capabilities and agents

See [Capabilities](/docs/capabilities) and [Agent trust](/docs/agent-trust).

| Export | Description |
| --- | --- |
| `defineCapability(config)` | Define one capability. From `@pracht/capabilities` |
| `invokeCapability(name, input, ctx)` | Trusted server-side call, including private capabilities. Resolves to the `{ ok, data }` or `{ ok, error }` envelope |
| `createCapabilityTestHost(options?)` | Drive capabilities in tests without booting a server |
| `setCapabilityAuditHook(hook)` | Receive a structured event for every capability call (single slot) |
| `addCapabilityAuditListener(name, hook)` | Add a named audit sink; the same name replaces it. Returns an unsubscribe function |
| `clearCapabilityAuditListeners()` | Remove every named audit sink |
| `setCapabilityApprovalStore(store)` | Persist approvals for the confirmation flow |
| `createMemoryApprovalStore(options?)` | An in-memory approval store, for development and tests |
| `createSqlApprovalStore({ execute })` | A durable approval store over your SQL client |
| `setCapabilityApprovalPrincipalResolver(fn)` | Decide which principal an approval belongs to |
| `setCapabilityConfirmationSecret(secret)` | Sign confirmation tokens |
| `verifyAgentSignature(request, options)` | Verify a Web Bot Auth request signature. Resolves to the agent identity, or `null` |

## Environment

See [Environment variables](/docs/env).

| Export | Description |
| --- | --- |
| `publicEnv` | Public variables, safe in the client bundle |
| `PRACHT_PUBLIC_ENV_PREFIX` | The prefix that marks a variable public |
| `filterPublicEnv(env)` | Reduce an env object to its public entries |
| `serverEnv` | Server-only variables. From `@pracht/core/env/server` |
| `setServerEnv(env)` | Supply the server env from an adapter that has no `process.env`. From `@pracht/core/env/server` |

## Fonts

| Export | Description |
| --- | --- |
| `defineFont(options)` | Self-hosted font with preload and `font-display` handling. See [Fonts](/docs/fonts) |

## Sessions

Import these from `@pracht/session`, which runs on every adapter. See [Authentication](/docs/recipes/auth).

| Export | Description |
| --- | --- |
| `createSessionStorage<Data>({ cookie, store?, rolling?, absoluteMaxAge? })` | Without `store`, data is sealed (AES-256-GCM) in the cookie; with one, the cookie holds a sealed id. `rolling: true` makes `maxAge` an idle timeout; `absoluteMaxAge` (seconds) caps the total lifetime |
| `sessionMiddleware(storage, options?)` | Loads the session onto `context.session` and commits changes after the chain. Does not gate |
| `requireSession(storage, options?)` | The same, plus a gate: page requests redirect to `loginPath` (default `"/login"`, with the original path in `?redirect=`), API requests get `401`. A session counts as authenticated when it has a `userId`, or when `isAuthenticated(session)` returns `true` |
| `createMemorySessionStore()` | In-memory `SessionStore` for tests and development |
| `hashPassword(password, options?)` | PBKDF2-HMAC-SHA256 hash that records its own parameters |
| `verifyPassword(password, stored)` | Constant-time check against a stored hash |
| `withSetCookie(response, header)` | Append a `Set-Cookie` and return the response, or a copy when its headers are immutable. Use the returned value |

| `cookie` option | Default | Description |
| --- | --- | --- |
| `secrets` | — | **Required.** Newest first, each at least 16 characters. The first seals; all of them open, so you rotate by prepending a new secret |
| `name` | `"__Host-session"` | Cookie name |
| `maxAge` | one week | Lifetime in seconds, counted from the last write |
| `path`, `domain` | `"/"`, host-only | Cookie scope |
| `sameSite` | `"Lax"` | `SameSite` attribute |
| `secure` | on | Off only over plain http from a loopback host. Always on for a `__Host-`/`__Secure-` name |
| `httpOnly` | `true` | `HttpOnly` attribute |

The middleware commits only when the session changed.

| `SessionStorage` method | Description |
| --- | --- |
| `getSession(request)` | The session for a request. An invalid or expired cookie yields a fresh empty session |
| `commitSession(session, options?)` | Seal and return the `Set-Cookie` value. Throws when a cookie session exceeds 4 KB |
| `commit(session, response, options?)` | The same, appended to a response; existing `Set-Cookie` headers are kept |
| `destroySession(session)` / `destroy(session, response)` | Delete the store record and expire the cookie |
| `isDirty(session)` | Whether the session changed this request |

| `Session` member | Description |
| --- | --- |
| `id` | Random 128-bit session id |
| `data` | Read-only snapshot; does not consume flash values |
| `get(key)` | Read a value, consuming it if it was flashed |
| `set(key, value)` / `unset(key)` / `has(key)` | Durable writes and presence |
| `flash(key, value)` | Write a value that survives exactly one read |
| `regenerate()` | New id, same data, old store record dropped. Call it on every privilege change, such as login, to prevent session fixation |

| `SessionStore` method | Description |
| --- | --- |
| `get(id)` | The stored record, or `null` when unknown or expired |
| `set(id, data, expiresAt)` | Persist the record. `expiresAt` is in `Date.now()` milliseconds |
| `delete(id)` | Remove the record. Must not throw on an unknown id |

## Companion packages

| Package | Key exports | Guide |
| --- | --- | --- |
| `@pracht/i18n` | `defineI18n`, `createDictionaries`, `t`, `tPlural`, `interpolate`, `matchAcceptLanguage`, `parseAcceptLanguage` | [i18n reference](/docs/reference/i18n) |
| `@pracht/image` | `Image`, `getImageProps`, `configureImage`, and the `cloudflareLoader`, `vercelLoader`, `netlifyLoader`, `passthroughLoader` loaders | [Images](/docs/images) |
| `@pracht/content` | `defineCollection`, `llmsTxtArtifacts`, `rawContentArtifacts`, `parseFrontmatter` | [Content collections](/docs/content) |
| `@pracht/markdown` | `defineMarkdownCollection` | [Content collections](/docs/content) |
| `@pracht/openapi` | `defineOpenApi`, `getOpenApiDescriptor`, `generateOpenApiDocument`, `createOpenApiUiHtml` | [OpenAPI](/docs/openapi) |
| `@pracht/query` | `createQueryRoot`, `getQueryClient`, `@pracht/query/root` | [TanStack Query](/docs/recipes/tanstack-query) |
| `@pracht/session` | See [Sessions](#sessions) | [Authentication](/docs/recipes/auth) |
| `@pracht/capabilities` | `defineCapability` | [Capabilities](/docs/capabilities) |
| `@pracht/test` | `createLoaderArgs`, `createApiArgs`, `createMiddlewareArgs`, `createTestRequest`, `runMiddleware`, `createFormRequest`, `submitForm`, `readJson`, `readRedirect` | [Testing](/docs/recipes/testing) |

## Adapter internals

`@pracht/core` and `@pracht/core/server` also export what [adapters](/docs/adapters) and the CLI use, such as `handlePrachtRequest`, `prerenderApp`, `buildAppGraph`, and `handleMcpRequest`. Apps rarely call them.
