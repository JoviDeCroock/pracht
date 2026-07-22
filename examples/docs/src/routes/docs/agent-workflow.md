---
title: AI-Assisted Authoring & Review
lead: LLMs write plausible code; frameworks should make it provable. pracht turns intent into machine truth — declared constraints, a committed app-graph snapshot, semantic diffs with <code>pracht plan</code>, and PR reports assembled from real build output.
breadcrumb: Agent Workflow
prev:
  href: /docs/llms
  title: LLM Content Negotiation
next:
  href: /docs/recipes/i18n
  title: i18n
---

## Why This Exists

When an agent writes a change, the interesting review question is rarely "is this valid TypeScript?" — it's "did the intent survive?" Did the new dashboard route keep the auth middleware? Did a route quietly switch from SSR to SSG? Did an API endpoint disappear?

Those are app-graph questions, and pracht resolves the entire app graph — routes, render modes, shells, middleware, API endpoints — from the manifest. That makes intent checkable by machine instead of by hoping a reviewer notices:

- **Constraints** declare invariants once; `pracht verify` enforces them deterministically.
- **`pracht plan`** diffs the resolved graph against a base git ref, so reviewers read an intent-level changelog instead of reverse-engineering it from file diffs.
- **`pracht report`** assembles the factual half of a PR description from machine truth.
- **Generated smoke tests** give every scaffolded route a Playwright check for free.
- **`pracht llms`** and the MCP server hand agents the framework's conventions directly.

---

## Constraints

Declare invariants over the route graph in `defineApp({ constraints })`. The helpers are exported from `@pracht/core`:

```ts [src/routes.ts]
import {
  defineApp,
  forbidRenderMode,
  requireHead,
  requireMiddleware,
  requireShell,
} from "@pracht/core";

export const app = defineApp({
  // shells, middleware, routes …
  constraints: [
    requireMiddleware("/app/**", "auth"),
    requireShell("/app/**", "app"),
    forbidRenderMode("/app/**", "ssg", "isg"),
    requireHead("**"),
  ],
});
```

| Helper                                  | Enforces                                                        |
| --------------------------------------- | --------------------------------------------------------------- |
| `requireMiddleware(pattern, ...names)`  | Matching routes include all of the given middleware             |
| `requireShell(pattern, ...shells)`      | Matching routes use one of the given shells                     |
| `requireRenderMode(pattern, ...modes)`  | Matching routes use one of the given render modes               |
| `forbidRenderMode(pattern, ...modes)`   | Matching routes use none of the given render modes              |
| `requireHead(pattern)`                  | Matching routes export `head()` — directly or via their shell   |

Patterns match route paths segment-wise: `*` matches exactly one segment, a trailing `**` matches zero or more segments, and `"**"` on its own matches every route. Literal segments compare against the declared path, so `/blog/*` matches `/blog/:slug`.

`pracht verify` evaluates constraints deterministically; violations are errors:

```
✖ Route "/app/billing" is missing required middleware "auth" (constraint pattern "/app/**").
```

An agent that scaffolds a new route under `/app` without the auth middleware fails verification immediately — no reviewer vigilance required. And because constraints live in the manifest, weakening one is a visible, reviewable policy change rather than a silent drift.

> [!NOTE]
> Constraints are evaluated for manifest apps (`defineApp`) in this release, not the pages router.

---

## The Route-Graph Lockfile

`pracht plan --write` snapshots the resolved app graph to `.pracht/app-graph.json` — commit it like a lockfile:

```sh
pracht plan --write
git add .pracht/app-graph.json
```

From then on, `pracht plan` diffs the live graph against the snapshot committed at a base ref (default `origin/main`) and prints what actually changed at the app level:

```sh
pracht plan
pracht plan --base origin/release
```

```
Pracht plan (base: origin/main)

+ route /pricing  render=isg  shell=public  middleware=[]
~ route /app/billing  middleware: [auth] → [auth, audit]
- api   /api/legacy-webhook
+ constraint require-middleware /app/**  middleware=["auth"]
```

That is the review artifact: added, removed, and changed routes, API endpoints, and constraints — not four hundred lines of moved imports. `--json` emits the full report for tooling, and `--markdown` formats the diff for PR comments.

`pracht verify` fails when the committed snapshot no longer matches the live graph, with the fix in the message: run `pracht plan --write`. So route changes can't land without the snapshot — and therefore the reviewable diff — updating alongside them.

---

## PR Reports from Machine Truth

`pracht report` assembles a PR-ready markdown report from three machine-derived sections:

```sh
pracht report
pracht report --base origin/release --out report.md
```

- **App graph changes** — the same diff `pracht plan --markdown` produces.
- **Verification** — the current `pracht verify` result, with any errors and warnings listed.
- **Client JS budgets** — per-route gzip sizes versus their limits, from the last `pracht build`.

Use it as the factual half of a PR description; the author (human or agent) adds the "why". The report footer marks the sections as machine-derived, so reviewers know which claims they don't need to re-check by hand.

---

## Generated Smoke Tests

`pracht generate route` emits a Playwright smoke test alongside the route whenever the app has a Playwright setup (a `playwright.config.*` file or an `e2e/` directory):

```sh
pracht generate route --path /blog/:slug --render ssg --shell public
# → src/routes/blog-slug.tsx
# → e2e/blog-slug.spec.ts
```

The test visits the route with example values for dynamic params and asserts the basics:

```ts [e2e/blog-slug.spec.ts]
import { expect, test } from "@playwright/test";

test("renders /blog/:slug", async ({ page }) => {
  const response = await page.goto("/blog/example-slug");
  expect(response?.status(), "route should serve successfully").toBeLessThan(400);
  await expect(page.locator("h1").first()).toHaveText("Blog Slug");
});
```

`--test` forces the test even without a detected Playwright setup; `--no-test` skips it. The MCP `generate_route` tool accepts a matching `test` boolean.

It's a floor, not a ceiling — but it means every agent-scaffolded route starts life with a failing-loudly check instead of zero coverage.

---

## Teaching the Agent: pracht llms and MCP

`pracht llms` prints an embedded authoring guide for coding agents — project layout, conventions, constraints, and the verify/plan/report loop. `--write` saves it as `llms.txt` in the app root so agents working in the repo pick it up:

```sh
pracht llms
pracht llms --write
```

The same CLI runs as an MCP server via `pracht mcp`. Alongside the existing `inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`, and `generate_*` tools, it exposes:

| Tool       | What it returns                                          |
| ---------- | -------------------------------------------------------- |
| `get_docs` | The same authoring guide as `pracht llms`                |
| `plan`     | The semantic app-graph diff                              |
| `report`   | The assembled markdown report                            |

An MCP-connected agent can read the conventions, scaffold with `generate_route` (tests included), check its own work with `verify`, and summarize the change with `report` — the whole loop without shell access.

---

## The Loop in CI

Run verification on every PR and post the plan as a comment:

```yaml [.github/workflows/verify.yml]
name: verify
on: pull_request

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # pracht plan reads the snapshot committed at the base ref.
          fetch-depth: 0
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm pracht verify
      - run: pnpm pracht plan --markdown --base origin/main > plan.md
      - run: gh pr comment "$PR" --body-file plan.md
        env:
          GH_TOKEN: ${{ github.token }}
          PR: ${{ github.event.pull_request.number }}
```

With that in place the review contract is simple: constraints hold (verify passed), the snapshot is fresh (verify passed), and the intent-level diff is sitting in the PR thread. The human review can spend its attention on whether the change is a good idea — the machine already checked whether it's the change it claims to be.
