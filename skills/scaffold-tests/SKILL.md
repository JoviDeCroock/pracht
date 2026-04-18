---
name: scaffold-tests
version: 1.0.0
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

**Browser mode**:

```bash
pnpm add -D vitest @vitest/browser playwright vitest-browser-preact
```

**JSDOM mode**:

```bash
pnpm add -D vitest jsdom @testing-library/preact @testing-library/jest-dom
```

Both: `pnpm add -D vitest @types/node`.

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

If `vitest.config.ts` already exists, merge — never clobber.

## Step 4: Generate the tests

Use `pracht inspect routes --json` and `pracht inspect api --json` to find
targets. Ask the user which subset to scaffold, or pass paths via
`$ARGUMENTS`.

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
  it("redirects unauthenticated requests", async () => {
    const request = new Request("http://localhost/dashboard");
    const result = await middleware({
      request,
      params: {},
      context: {} as never,
      url: new URL(request.url),
      signal: AbortSignal.timeout(5000),
      route: {} as never,
    });
    expect(result).toEqual({ redirect: expect.stringMatching(/^\/login/) });
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
