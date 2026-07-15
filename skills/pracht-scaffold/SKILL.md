---
name: pracht-scaffold
version: 1.1.0
description: |
  Pracht code scaffolding. Prefer the framework-native CLI generators
  (`pracht generate route|shell|middleware|api`) and only fall back to manual
  edits when the CLI flags cannot express the requested shape. Knows pracht
  conventions (Preact idioms, render modes, route manifest).
  Use when asked to "scaffold", "generate a route", "create a new page",
  "add middleware", "add an API route", or "create a shell".
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

Generate pracht framework modules with correct types, exports, and manifest wiring.

## First Choice

Use the CLI first:

```bash
pracht generate route --path /dashboard --render ssr
pracht generate shell --name app
pracht generate middleware --name auth
pracht generate api --path /health --methods GET,POST
```

`pracht generate route` supports the full flag matrix below — do not fall back to manual edits for shapes it already covers:

| Flag               | Meaning                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ |
| `--path` (required) | Route path, e.g. `/dashboard` or `/blog/:slug`                                       |
| `--render`         | Render mode: `ssr` (default), `spa`, `ssg`, or `isg`                                 |
| `--shell`          | Registered shell name (manifest apps only)                                           |
| `--middleware`     | Registered middleware names, comma-separated (manifest apps only)                    |
| `--loader`         | Include a `loader` export                                                            |
| `--error-boundary` | Include an `ErrorBoundary` export                                                    |
| `--static-paths`   | Include `getStaticPaths` (added automatically for dynamic `ssg`/`isg` paths)         |
| `--title`          | Page title used in the `head()` export                                               |
| `--revalidate`     | ISG revalidation window in seconds (`isg` only, default 3600)                        |
| `--json`           | Machine-readable output                                                              |

`generate shell` and `generate middleware` take `--name`; `generate api` takes `--path` and `--methods` (comma-separated). All subcommands accept `--json`.

- `--shell`/`--middleware` names must already be registered in the app manifest — the CLI errors otherwise. Generate the shell/middleware first, then the route that references it.
- If the pracht MCP server is registered (docs/MCP.md), call the `generate_route`/`generate_shell`/`generate_middleware`/`generate_api` MCP tools instead of Bash — same behavior, structured results.
- Add `--json` when another agent/tool needs machine-readable output.
- `generate route` also emits a Playwright smoke test in `e2e/` when the app has a Playwright setup (`playwright.config.*` or an `e2e/` directory). Pass `--no-test` to skip it, `--test` to force it. Keep the generated test — it is the output-level proof the route works.
- Use `pracht inspect routes --json` or `pracht inspect api --json` to confirm current wiring before manual edits when the existing graph matters. `pracht inspect` requires the pracht plugin registered in the project's vite config.
- If the app has typed routes (`src/pracht-routes.ts` / `.d.ts`) or the user asks for typed links, run `pracht typegen` after adding or renaming routes.
- If the app commits `.pracht/app-graph.json`, run `pracht plan --write` after changing routes and include the refreshed snapshot — `pracht verify` fails when it is stale.
- If `src/routes.ts` declares `constraints:`, respect them (e.g. put new `/app/**` routes behind the required middleware). Never delete or weaken a constraint to make `pracht verify` pass — that is a policy change the user must approve.
- If the CLI can express the request, do not reimplement the scaffold by hand.
- Only edit files manually when the CLI cannot cover the requested shape.

The user will describe what they want to create. Parse their request and generate the appropriate module(s). Always ask if anything is ambiguous (e.g. render mode, shell assignment).

## What You Can Scaffold

| Kind       | Directory         | Key exports                                                          | Example                        |
| ---------- | ----------------- | -------------------------------------------------------------------- | ------------------------------ |
| Route      | `src/routes/`     | `loader`, `head`, `Component`, `ErrorBoundary`, `getStaticPaths`     | `src/routes/blog.tsx`          |
| Shell      | `src/shells/`     | `Shell`, `head`                                                      | `src/shells/marketing.tsx`     |
| Middleware | `src/middleware/` | `middleware`                                                         | `src/middleware/rate-limit.ts` |
| API route  | `src/api/`        | Named HTTP method handlers (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) or one default method dispatcher           | `src/api/users/[id].ts`        |

## Templates (manual fallback)

Use these only when the CLI cannot express the requested shape.

### Route

```tsx
export function head() {
  return { title: "Page Title" };
}

export function Component() {
  return <section>{/* route UI */}</section>;
}
```

- Include a `loader` only when the route needs server data (matches the CLI, which omits it unless `--loader` is passed):

  ```tsx
  import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

  export async function loader(_args: LoaderArgs) {
    return {
      /* loader data */
    };
  }

  export function Component({ data }: RouteComponentProps<typeof loader>) {
    return <section>{/* route UI */}</section>;
  }
  ```

- Include `ErrorBoundary` only if requested.
- Include `getStaticPaths` only for SSG/ISG routes with dynamic segments.
- Use `RouteComponentProps<typeof loader>` for typed `data` prop.

### Shell

```tsx
import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return (
    <div class="shell-name">
      <nav>{/* navigation */}</nav>
      <main>{children}</main>
    </div>
  );
}

export function head() {
  return { title: "Shell Title" };
}
```

### Middleware

Middleware wraps the rest of the request via `next()`:

```ts
import { redirect, type MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ context, request }, next) => {
  // Mutate context, validate auth, etc.
  // - Call `return next()` to continue
  // - Return `redirect("/path", { request })` to short-circuit with a redirect
  // - Return any `Response` to short-circuit
  // - Wrap `await next()` in try/catch/finally for tracing/logging
  return next();
};
```

### API Route

```ts
import type { ApiRouteArgs } from "@pracht/core";

export function GET({ params, url }: ApiRouteArgs) {
  return Response.json({
    /* response data */
  });
}
```

- Only include the HTTP methods the user needs.
- Use a default export only when the user wants to branch on `request.method` manually.
- Use `request.json()`, `request.formData()`, etc. for body parsing.
- Always return `Response` objects (typically `Response.json()`).
- Dynamic segments use bracket syntax in filenames: `[id].ts`, `[...slug].ts`.

## Wiring Into the Manifest (manual fallback only)

The CLI generators wire the manifest themselves: `pracht generate route` inserts the `route(...)` call into `src/routes.ts` (adding `route`/`timeRevalidate` imports as needed), and `generate shell`/`generate middleware` upsert their registry entries. **Do not re-edit the manifest after a successful `pracht generate` run.**

Only when you created module files by hand, update `src/routes.ts` to register the new module:

- **Routes**: Add a `route("/path", () => import("./routes/filename.tsx"), { id: "name", render: "ssr" })` call inside the appropriate group or at the top level. Plain strings like `"./routes/filename.tsx"` also work.
- **Shells**: Add to the `shells` record: `shellName: () => import("./shells/filename.tsx")` (or `"./shells/filename.tsx"`).
- **Middleware**: Add to the `middleware` record: `mwName: () => import("./middleware/filename.ts")` (or `"./middleware/filename.ts"`).
- **API routes**: No manifest change needed — auto-discovered from `src/api/` by the Vite plugin.

Available render modes: `"ssr"` (default), `"ssg"` (static at build), `"isg"` (incremental static with `revalidate: timeRevalidate(seconds)`), `"spa"` (client-only).

Import `timeRevalidate` from `"@pracht/core"` when using ISG.

## Rules

1. Prefer `pracht generate ...` over manual edits.
2. Read the project's existing `src/routes.ts` to determine current shells, middleware, and route structure before adding when the CLI cannot finish the job on its own.
3. Place files in the conventional directories (`src/routes/`, `src/shells/`, `src/middleware/`, `src/api/`).
4. Keep generated code minimal — only include exports the user actually needs.
5. Use Preact idioms: `class` not `className`, functional components, `import type` for type-only imports.
6. When route ids/paths change in a typed-routes app, run `pracht typegen` and include the generated route files.
7. Finish with `pracht verify` (and `pracht plan --write` when the app commits an app-graph snapshot).
8. After scaffolding, summarize what was created and how it was wired.

$ARGUMENTS
