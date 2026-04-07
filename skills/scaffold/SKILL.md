---
name: scaffold
version: 1.0.0
description: |
  Previte code scaffolding. Generates routes, shells, middleware, and API route
  modules with correct types, exports, and manifest wiring. Knows previte
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

# Previte Scaffold

Generate previte framework modules with correct types, exports, and manifest wiring.

The user will describe what they want to create. Parse their request and generate the appropriate module(s). Always ask if anything is ambiguous (e.g. render mode, shell assignment).

## What You Can Scaffold

| Kind       | Directory         | Key exports                                                                | Example                        |
| ---------- | ----------------- | -------------------------------------------------------------------------- | ------------------------------ |
| Route      | `src/routes/`     | `loader`, `action`, `head`, `Component`, `ErrorBoundary`, `getStaticPaths` | `src/routes/blog.tsx`          |
| Shell      | `src/shells/`     | `Shell`, `head`                                                            | `src/shells/marketing.tsx`     |
| Middleware | `src/middleware/` | `middleware`                                                               | `src/middleware/rate-limit.ts` |
| API route  | `src/api/`        | Named HTTP method handlers (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`)       | `src/api/users/[id].ts`        |

## Templates

### Route

```tsx
import type { LoaderArgs, RouteComponentProps } from "previte";

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

- Include `action` only if the user asks for form handling or mutations.
- Include `ErrorBoundary` only if requested.
- Include `getStaticPaths` only for SSG/ISG routes with dynamic segments.
- Use `RouteComponentProps<typeof loader>` for typed `data` prop.
- Import `Form` from `"previte"` when adding actions.

### Shell

```tsx
import type { ShellProps } from "previte";

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
import type { MiddlewareFn } from "previte";

export const middleware: MiddlewareFn = async ({ request }) => {
  // Return void to continue, { redirect: "/path" } to redirect,
  // a Response to short-circuit, or { context: { ... } } to augment context.
};
```

### API Route

```ts
import type { BaseRouteArgs } from "previte";

export function GET({ params, url }: BaseRouteArgs) {
  return Response.json({
    /* response data */
  });
}
```

- Only include the HTTP methods the user needs.
- Use `request.json()`, `request.formData()`, etc. for body parsing.
- Always return `Response` objects (typically `Response.json()`).
- Dynamic segments use bracket syntax in filenames: `[id].ts`, `[...slug].ts`.

## Wiring Into the Manifest

After creating module files, **always update `src/routes.ts`** to register the new module:

- **Routes**: Add a `route("/path", "./routes/filename.tsx", { id: "name", render: "ssr" })` call inside the appropriate group or at the top level.
- **Shells**: Add to the `shells` record: `shellName: "./shells/filename.tsx"`.
- **Middleware**: Add to the `middleware` record: `mwName: "./middleware/filename.ts"`.
- **API routes**: No manifest change needed — auto-discovered from `src/api/` by the Vite plugin.

Available render modes: `"ssr"` (default), `"ssg"` (static at build), `"isg"` (incremental static with `revalidate: timeRevalidate(seconds)`), `"spa"` (client-only).

Import `timeRevalidate` from `"previte"` when using ISG.

## Rules

1. Read the project's existing `src/routes.ts` to determine current shells, middleware, and route structure before adding.
2. Place files in the conventional directories (`src/routes/`, `src/shells/`, `src/middleware/`, `src/api/`).
3. Keep generated code minimal — only include exports the user actually needs.
4. Use Preact idioms: `class` not `className`, functional components, `import type` for type-only imports.
5. After scaffolding, summarize what was created and how it was wired.

$ARGUMENTS
