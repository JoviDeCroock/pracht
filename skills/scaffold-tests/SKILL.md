---
name: scaffold-tests
version: 1.1.0
description: |
  Scaffold Vitest unit/integration tests for pracht routes, loaders, and
  middleware. Asks the user once whether to use vitest browser mode with
  `vitest-browser-preact` (real DOM, real events) or classic JSDOM-based
  tests with `@testing-library/preact`. Wires `vitest.config.ts`, mocks
  `LoaderArgs`, and emits ready-to-run files.
  Use when asked to "scaffold tests", "set up Vitest", "add unit tests",
  "test this loader", or "test this route".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Scaffold Tests

Generate Vitest tests aligned with pracht's testing recipe
(`examples/docs/src/routes/docs/recipes-testing.md`). Loaders and API handlers
are plain async functions — they test directly with no framework bootstrap.
Component tests need a renderer; the user picks the flavor.

## Step 1: Pick the rendering strategy

Use `AskUserQuestion` to choose between:

1. **Browser mode** — `vitest` with `@vitest/browser` and
   `vitest-browser-preact`.
   - Pros: real browser, real events, fewer hydration false positives,
     screenshots, works for SPA-mode interaction tests.
   - Cons: slower, heavier setup, requires a browser binary on CI.
2. **JSDOM** — `vitest` with `@testing-library/preact`.
   - Pros: fast, lightweight, runs anywhere.
   - Cons: JSDOM lacks layout, certain DOM APIs; brittle for complex UIs.

If the project already has one configured, default to it and confirm.

## Step 2: Install dependencies

Detect the package manager from the lockfile.

Common (both modes):

```bash
pnpm add -D vitest @types/node
```

Component-test extras — `@preact/preset-vite` must be an explicit dev
dependency: the configs in Step 3 import it, and a transitive-only copy
fails under pnpm's strict `node_modules`.

**Browser mode**:

```bash
pnpm add -D @vitest/browser playwright vitest-browser-preact @preact/preset-vite
```

**JSDOM mode**:

```bash
pnpm add -D jsdom @testing-library/preact @testing-library/jest-dom @preact/preset-vite
```

If the project only needs loader/middleware tests (no component rendering),
skip the extras entirely and use the plugin-less config in Step 3.

## Step 3: Wire `vitest.config.ts`

**Browser mode**:

```ts
import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  test: {
    browser: {
      enabled: true,
      provider: "playwright",
      instances: [{ browser: "chromium" }],
    },
  },
});
```

**JSDOM mode**:

```ts
import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
  },
});
```

`test/setup.ts` (JSDOM only):

```ts
import "@testing-library/jest-dom/vitest";
```

**Loader/middleware-only mode** (no components) — matches the minimal config
in `recipes-testing.md`; no preset, no extra deps:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Exclude E2E tests (run those with Playwright)
    exclude: ["e2e/**", "node_modules/**"],
  },
});
```

If `vitest.config.ts` already exists, merge — never clobber.

## Step 4: Generate the tests

If the pracht MCP server is registered (see docs/MCP.md), prefer its tools
(`inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`,
`generate_*`) over shelling out. Prerequisite: `pracht inspect` needs a vite
config with the pracht plugin registered.

This skill covers **loaders, middleware, and components**. For API handlers
(`src/api/**`), delegate to `/pracht-test-api` — it owns handler enumeration and
per-method test generation; don't duplicate a weaker version here.

Use `pracht inspect routes --json` to find targets. Ask the user which subset
to scaffold, or pass paths via `$ARGUMENTS`.

### Loader test template

```ts
import { describe, it, expect } from "vitest";
import { loader } from "./<route-file>";

function args(url: string, init?: RequestInit) {
  const request = new Request(url, init);
  return {
    request,
    params: {} as Record<string, string>,
    context: {} as never,
    url: new URL(request.url),
    signal: AbortSignal.timeout(5000),
    route: {} as never,
  };
}

describe("<route> loader", () => {
  it("returns the expected shape", async () => {
    const data = await loader(args("http://localhost/<path>"));
    expect(data).toBeDefined();
  });
});
```

### Middleware test template

```ts
import { describe, it, expect } from "vitest";
import { middleware } from "./<middleware-file>";

describe("<name> middleware", () => {
  const ok = new Response("ok", { status: 200 });
  const next = async () => ok;

  it("redirects unauthenticated requests", async () => {
    const request = new Request("http://localhost/dashboard");
    const response = await middleware(
      {
        request,
        params: {},
        context: {} as never,
        url: new URL(request.url),
        signal: AbortSignal.timeout(5000),
        route: {} as never,
      },
      next,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(/^\/login/);
  });

  it("calls through when authenticated", async () => {
    const request = new Request("http://localhost/dashboard", {
      headers: { cookie: "session=valid" },
    });
    const response = await middleware(
      {
        request,
        params: {},
        context: {} as never,
        url: new URL(request.url),
        signal: AbortSignal.timeout(5000),
        route: {} as never,
      },
      next,
    );
    expect(response).toBe(ok);
  });
});
```

### Component test template (browser mode)

```tsx
import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-preact";
import { Component } from "./<route-file>";

describe("<route> component", () => {
  it("renders the heading", async () => {
    const screen = render(<Component data={{ /* mock loader data */ }} params={{}} />);
    await expect.element(screen.getByRole("heading")).toBeVisible();
  });
});
```

### Component test template (JSDOM)

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/preact";
import { Component } from "./<route-file>";

describe("<route> component", () => {
  it("renders the heading", () => {
    render(<Component data={{ /* mock loader data */ }} params={{}} />);
    expect(screen.getByRole("heading")).toBeInTheDocument();
  });
});
```

## Step 5: Wire `package.json`

Add (or merge) scripts:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

If `pnpm test` already exists, do not overwrite.

## Step 6: Verify

```bash
pnpm test
pracht verify --json
```

If anything fails on first run, report the failure and the fix. Do not commit
broken scaffolding.

## Rules

1. Ask the rendering-strategy question once per project; persist by
   inspecting `vitest.config.ts` on subsequent runs.
2. Only test exports that exist — read the route file before generating.
3. Use the recipe's `args()` helper shape for `BaseRouteArgs`/`LoaderArgs`
   construction.
4. For routes with `getStaticPaths`, scaffold a separate test that calls it.
5. Generated tests should pass on first run with a placeholder assertion;
   the user fills in real expectations.

$ARGUMENTS
