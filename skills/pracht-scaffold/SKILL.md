---
name: pracht-scaffold
version: 1.3.0
description: |
  Scaffold pracht code with the native generators (`pracht generate
  route|shell|middleware|api`), falling back to manual edits only when the CLI
  flags cannot express the requested shape.
  Use for "scaffold", "generate a route", "create a new page", "add middleware",
  "add an API route", "create a shell".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Scaffold

Parse what the user wants to create and generate it with the CLI. Ask when
something is ambiguous (render mode, shell assignment). Keep generated code
minimal — only the exports they actually need — and finish by summarizing what
was created and how it was wired.

## Always try the CLI first

```bash
pracht generate route --path /dashboard --render ssr
pracht generate shell --name app
pracht generate middleware --name auth
pracht generate api --path /health --methods GET,POST
```

If the CLI can express the request, do not reimplement the scaffold by hand.
`pracht generate route` covers this flag matrix:

| Flag                | Meaning                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| `--path` (required) | Route path, e.g. `/dashboard` or `/blog/:slug`                               |
| `--render`          | `ssr` (default), `spa`, `ssg`, or `isg`                                      |
| `--shell`           | Registered shell name (manifest apps only)                                   |
| `--middleware`      | Registered middleware names, comma-separated (manifest apps only)            |
| `--loader`          | Include a `loader` export                                                    |
| `--error-boundary`  | Include an `ErrorBoundary` export                                            |
| `--static-paths`    | Include `getStaticPaths` (automatic for dynamic `ssg`/`isg` paths)           |
| `--title`           | Page title for the `head()` export                                           |
| `--revalidate`      | ISG window in seconds (`isg` only, default 3600)                             |
| `--json`            | Machine-readable output                                                      |

`generate shell` and `generate middleware` take `--name`; `generate api` takes
`--path` and `--methods`. All subcommands accept `--json` — use it when another
agent or tool consumes the output. When the pracht MCP server is registered
(docs/MCP.md), call the `generate_route`/`generate_shell`/`generate_middleware`/
`generate_api` MCP tools instead of Bash: same behavior, structured results.

- `--shell`/`--middleware` names must already be registered or the CLI errors.
  Generate the shell or middleware first, then the route referencing it.
- Pages-router apps have one middleware seam: `pracht generate middleware
  --name _middleware` scaffolds the root `src/pages/_middleware.ts`, which runs
  on every page route (API routes are not wrapped). Other names error in pages
  mode, pure static exports cannot use request middleware, and `generate shell`
  stays manifest-only (`_app.tsx` is the pages shell).
- `generate route` also emits a Playwright smoke test in `e2e/` when the app
  has a Playwright setup (`playwright.config.*` or an `e2e/` directory);
  `--no-test` skips it, `--test` forces it. The test imports
  `@playwright/test` — if that dependency is missing, follow the generator's
  install note before typechecking. Keep the test: it is the output-level proof
  the route works.
- **The generators wire the manifest themselves.** `generate route` inserts the
  `route(...)` call into `src/routes.ts` (adding `route`/`timeRevalidate`
  imports as needed) and `generate shell`/`generate middleware` upsert their
  registry entries. Do not re-edit the manifest after a successful run.

## Project conventions

| Kind       | Directory         | Key exports                                                                      |
| ---------- | ----------------- | -------------------------------------------------------------------------------- |
| Route      | `src/routes/`     | `loader`, `head`, `Component`, `ErrorBoundary`, `getStaticPaths`                 |
| Shell      | `src/shells/`     | `Shell`, `head`                                                                  |
| Middleware | `src/middleware/` | `middleware`                                                                     |
| API route  | `src/api/`        | Named method handlers (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) or one default dispatcher |

Render modes: `"ssr"` (default), `"ssg"` (static at build), `"isg"`
(incremental static, `revalidate: timeRevalidate(seconds)` — import
`timeRevalidate` from `@pracht/core`), `"spa"` (client-only). Use Preact
idioms: `class` not `className`, functional components, `import type` for
type-only imports.

Before and after scaffolding:

- Read `pracht inspect routes --json` / `pracht inspect api --json` to confirm
  current wiring when the existing graph matters. `pracht inspect` needs the
  pracht plugin in the vite config.
- If `src/routes.ts` declares `constraints:`, respect them — e.g. put new
  `/app/**` routes behind the required middleware. Never delete or weaken a
  constraint to make `pracht verify` pass; that is a policy change only the
  user can approve.
- Run `pracht typegen` after adding or renaming routes in a typed-routes app
  (`src/pracht-routes.ts` / `.d.ts`), and include the generated files.
- Run `pracht plan --write` if the app commits `.pracht/app-graph.json` —
  `pracht verify` fails on a stale snapshot.
- Finish with `pracht verify`.

## Manual fallback

Only for shapes the CLI cannot express. Read the existing `src/routes.ts` first
to pick up current shells, middleware, and structure.

**Route** — `head()` plus `Component`; add `loader` only when the route needs
server data (the CLI omits it unless `--loader` is passed), `ErrorBoundary`
only if requested, and `getStaticPaths` only for SSG/ISG routes with dynamic
segments:

```tsx
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

export async function loader(_args: LoaderArgs) {
  return {/* loader data */};
}

export function head() {
  return { title: "Page Title" };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return <section>{/* route UI */}</section>;
}
```

**Shell** — `Shell({ children }: ShellProps)` rendering `{children}`, plus an
optional `head()`. Never render `<html>`, `<head>`, or `<body>`.

**Middleware** — wrap-around via `next()`:

```ts
import { redirect, type MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ context, request }, next) => {
  // `return next()` continues; returning any Response short-circuits, e.g.
  // `redirect("/path", { request })`. Wrap `await next()` in try/catch/finally
  // for tracing.
  return next();
};
```

**API route** — one export per method the user needs (or a default export only
when they want to branch on `request.method` manually), parsing bodies with
`request.json()` / `request.formData()` and always returning a `Response`:

```ts
import type { ApiRouteArgs } from "@pracht/core";

export function GET({ params, url }: ApiRouteArgs) {
  return Response.json({/* response data */});
}
```

Dynamic segments use bracket filenames: `[id].ts`, `[...slug].ts`. API routes
are auto-discovered — no manifest entry.

For live server→client updates, use Server-Sent Events:
`createEventStream(request, { keepAlive: 15 })` from `@pracht/core/server`
returns `{ response, send, close }` — return `response`, push with
`send({ data, event?, id? })`, and stop producing when `send()` returns `false`
(client disconnected). Consume with `useEventSource(url, { json: true })` from
`@pracht/core`. Works on every adapter. For WebSockets use
`isUpgradeRequest(request)` plus the per-adapter recipes in `docs/ADAPTERS.md`
(Cloudflare: API route + Durable Object; Node:
`nodeAdapter({ configureServerFrom })`; Vercel: unsupported — use SSE).

**Manifest wiring**, only for hand-created files:

- Route — a `route("/path", () => import("./routes/file.tsx"), { id: "name",
  render: "ssr" })` call in the right group or at the top level.
- Shell — `shellName: () => import("./shells/file.tsx")` in the `shells` record.
- Middleware — `mwName: () => import("./middleware/file.ts")` in the
  `middleware` record.

Plain `"./routes/file.tsx"` strings work in place of the import functions.

$ARGUMENTS
