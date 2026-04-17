---
name: scaffold
version: 1.0.0
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

- Add `--json` when another agent/tool needs machine-readable output.
- Use `pracht inspect routes --json` or `pracht inspect api --json` to confirm current wiring before manual edits when the existing graph matters.
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

## Templates

### Route

```tsx
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

export async function loader(_args: LoaderArgs) {
  return {
    /* loader data */
  };
}

export function head() {
  return { title: "Page Title" };
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

```ts
import type { MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request }) => {
  // Return void to continue, { redirect: "/path" } to redirect,
  // a Response to short-circuit, or { context: { ... } } to augment context.
};
```

### API Route

```ts
import type { BaseRouteArgs } from "@pracht/core";

export function GET({ params, url }: BaseRouteArgs) {
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

## Wiring Into the Manifest

After creating module files, **always update `src/routes.ts`** to register the new module:

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
6. After scaffolding, summarize what was created and how it was wired.

$ARGUMENTS
