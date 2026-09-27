---
title: Coding Agents
lead: The other kind of agent — the one writing your app rather than using it. pracht hands coding agents the resolved app graph over MCP, an embedded authoring guide, installable skills, and machine-checkable proof that the change is the change it claims to be.
breadcrumb: Coding Agents
prev:
  href: /docs/agent-trust
  title: Agent Trust
next:
  href: /docs/recipes/i18n
  title: i18n
---

## Two Different Kinds of Agent

"Agent" means two unrelated things in a pracht app. This page covers the development rows:

| | Audience | When | What it exposes |
| --- | --- | --- | --- |
| **`pracht dev-mcp`** (this page) | Your coding agent — Claude Code, Cursor, an MCP client on your machine | **Development** | Your app's *graph*: routes, API endpoints, capabilities, diagnostics, scaffolding |
| **[Dev page tools](#debugging-in-the-tab-dev-page-tools)** (this page) | A WebMCP-compatible agent or test harness driving your app | **Development** | *This tab*: matched route, loader data, islands, last error, and page tools |
| **[Remote MCP](/docs/capabilities#remote-mcp-tools-for-agents-without-a-browser)** | End-user agents calling your deployed app | **Production** | Your app's *operations*: capabilities served as MCP tools over Streamable HTTP |

The development tools never ship: they run on your machine, not in your deployed app.

The rest of this page makes an agent's changes *provable*. The real review question is "did the intent survive?" Did the new route keep its auth middleware? Did a capability become public? pracht resolves the whole app graph, so a machine can answer.

---

## The Authoring MCP Server

`pracht dev-mcp` hands an agent the *resolved* app graph, so it does not glob `src/` and guess. Each tool returns the same output as the matching CLI command.

```sh
pracht dev-mcp
```

It speaks MCP over stdio and runs until the client disconnects, so your MCP client starts it, not you. `pracht mcp` is a deprecated alias. See the [CLI reference](/docs/cli#pracht-dev-mcp).

### Registering It

With Claude Code, from an app directory that has `@pracht/cli` installed:

```sh
claude mcp add pracht -- npx --no-install pracht dev-mcp
```

Or commit an `.mcp.json` at the repository root so every collaborator and CI agent picks it up:

```json [.mcp.json]
{
  "mcpServers": {
    "pracht": {
      "command": "npx",
      "args": ["--no-install", "pracht", "dev-mcp"]
    }
  }
}
```

Keep `--no-install`. It pins the server to the `@pracht/cli` this project depends on and fails loudly when it is missing. Without it, `npx pracht` can fetch an unrelated registry package named `pracht`.

Apps scaffolded with `create-pracht` get this file and the [core skills](#agent-skills) unless you pass `--no-agent-tools`. Cursor (`.cursor/mcp.json`), VS Code (`.vscode/mcp.json`), and other stdio clients take the same `command`/`args` shape; run it from the app root.

### Tools

Every tool accepts an optional `cwd` (absolute path to the app root). It defaults to the server's working directory.

**Inspection:** `inspect_routes`, `inspect_api`, `inspect_capabilities`, `inspect_agents`, and `inspect_build` return the same payload as [`pracht inspect <target> --json`](/docs/cli#pracht-inspect). `inspect_build` needs a prior `pracht build`.

**Diagnosis and review:**

| Tool | Inputs | Returns |
| --- | --- | --- |
| `doctor` | — | Wiring diagnostics with per-check status |
| `verify` | `changed?` | Verification results, including [constraints](#constraints) and snapshot freshness |
| `plan` | `base?` (default `origin/main`), `write?` | The [app-graph diff](#the-route-graph-lockfile), with `widensAgentSurface`. `write: true` refreshes the snapshot |
| `report` | `base?` | [PR-ready markdown](#pr-reports-from-machine-truth) |
| `typegen` | `check?` | Regenerates typed routes and capability types; `check: true` only reports staleness |
| `eval` | `url`, `files?` | Runs eval scenarios against an app you already started |
| `get_docs` | — | The authoring guide from `pracht llms`. Agents should read it first |

**Scaffolding:** `generate_route`, `generate_shell`, `generate_middleware`, `generate_api`, and `generate_capability` take the [`pracht generate`](/docs/cli#pracht-generate) flags as camelCase inputs (`errorBoundary`, `staticPaths`), with lists as arrays. Each returns `{ kind, created, updated }`. When you edit a generated capability, keep `expose` and `effect` inline literals.

### Error Handling

A failed call — a missing manifest, an unknown shell, a refusal to overwrite a file — returns an MCP `isError` result with the message. The server keeps running, so the agent can correct its input and retry.

---

## Debugging in the Tab: Dev Page Tools

An agent driving a browser against `pracht dev` sees the page but not the framework's view of it. So every document `pracht dev` serves registers five read-only [WebMCP](/docs/capabilities#webmcp-tools-for-in-browser-agents) page tools that describe it:

| Tool | Answers |
| --- | --- |
| `pracht_route` | The matched route: id, URL, params, render and hydration mode, streaming, shells, files, middleware, capabilities, and whether it is the not-found page |
| `pracht_loader_data` | The loader data the page holds now, including after client navigation and revalidation. Pass `{ path: "notes.0.title" }` to read one value |
| `pracht_islands` | Every `<pracht-island>` on the page with its source file, client strategy, props, and hydration status |
| `pracht_last_error` | The server error this document rendered (dev overlay or `ErrorBoundary` state), plus recent uncaught client errors with stacks |
| `pracht_page_tools` | The app's own WebMCP tools on this route, and why any declared capability is *not* one |

Each returns a capability's `{ ok, data }` / `{ ok: false, error }` envelope. They follow client-side navigation, so after a click `pracht_route` describes the new page.

Nothing needs installing, but the browser or test harness must support WebMCP. `pracht dev` injects their script into every HTML document, including the 404 page and error overlay; production builds never contain it. Turn it off with `pracht({ devPageTools: false })` in `vite.config.ts`.

```sh
pracht dev
# then, from an agent-driven browser on http://localhost:3000/notes:
# pracht_route        → { ok: true, data: { routeId: "notes", render: "ssr", hydration: "full", … } }
# pracht_loader_data  → { ok: true, data: { data: { notes: [ … ] } } }
# pracht_last_error   → { ok: true, data: { server: null, client: [] } }
```

- **Loader data is what the browser has.** Routes with `hydration: "islands"` or `"none"` never ship loader data. `pracht_loader_data` returns an error naming the request that reads the route state from the server instead: the route URL with the `x-pracht-route-state-request: 1` header.
- **It is a debugging surface, not a security boundary.** Loader data and stack traces contain whatever your loaders return. The tools are read-only and exist only on the dev server, so keep that server private.

---

## Teaching the Agent: pracht llms

[`pracht llms`](/docs/cli#pracht-llms) prints pracht's authoring guide for coding agents: project layout, conventions, constraints, and the verify/plan/report loop. `pracht llms --write` saves it as `llms.txt` in the app root, and the `get_docs` MCP tool serves the same text.

> [!NOTE]
> This is the *framework's* guide, for an agent editing your source. It is unrelated to the [`llms.txt` your app generates](/docs/agents#llmstxt) for agents *using* your deployed site. Same filename, opposite direction.

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

Patterns match route paths segment by segment: `*` matches one segment, a trailing `**` matches zero or more, and `"**"` alone matches every route. `/blog/*` matches `/blog/:slug`.

`pracht verify` reports each violation as an error:

```
✖ Route "/app/billing" is missing required middleware "auth" (constraint pattern "/app/**").
```

So an agent that scaffolds a route under `/app` without `auth` fails verification immediately. Manifest apps declare constraints in `defineApp()`; pages apps export them from the root `src/pages/_app.config.ts`. A changed constraint appears in the `pracht plan` diff, so weakening one is a visible policy change.

---

## The Route-Graph Lockfile

`pracht plan --write` snapshots the resolved app graph to `.pracht/app-graph.json`. Commit it like a lockfile:

```sh
pracht plan --write
git add .pracht/app-graph.json
```

From then on, `pracht plan` diffs the live graph against the snapshot committed at a base ref (default `origin/main`). Flags are in the [CLI reference](/docs/cli#pracht-plan).

```
Pracht plan (base: origin/main)

+ route /pricing  render=isg  shell=public  middleware=[]
~ route /app/billing  middleware: [auth] → [auth, audit]
- api   /api/legacy-webhook
! capability notes.purge  now exposed via mcp — reachable by agents
+ constraint require-middleware /app/**  middleware=["auth"]
```

That is the review artifact: the routes, API endpoints, capabilities, and constraints that changed — not four hundred lines of moved imports. `--markdown` formats it for a PR comment.

### The Line You Cannot Afford to Miss

A `!` marks a change that widened what agents can reach or weakened a guard:

- a new exposure
- a `destructive` capability reclassified out of the confirmation flow
- an `agentPolicy` downgraded from `require`
- dropped middleware
- an input schema that accepts more: a removed `required` field, an opened `additionalProperties`, or a raised bound, including nested ones (`input.limit: maximum raised (50 → 5000)`)
- enabling `agents.mcp`, or `agents.mcp.destructive` once a destructive MCP tool can be served

Narrowings and removals stay quiet. A line diff hides these one-word edits; the plan flags them. When anything widened, `--markdown` adds a callout above the diff, and `pracht report` carries it into the PR body.

`pracht verify` fails when the committed snapshot is stale and tells you to run `pracht plan --write`, so graph changes cannot land without the reviewable diff.

---

## PR Reports from Machine Truth

[`pracht report`](/docs/cli#pracht-report) assembles PR-ready markdown from three machine-derived sections:

- **App graph changes** — the same diff `pracht plan --markdown` produces.
- **Verification** — the current `pracht verify` result, with any errors and warnings.
- **Client JS budgets** — per-route gzip sizes against their limits, from the last `pracht build`.

Use it as the factual half of a PR description; the author adds the "why". Its footer marks these sections as machine-derived.

---

## Generated Smoke Tests

`pracht generate route` emits a Playwright smoke test alongside the route when the app has a Playwright setup (a `playwright.config.*` file or an `e2e/` directory):

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

`--test` forces the test and `--no-test` skips it (`test` in the MCP tool). Without Playwright installed, the generator prints the `@playwright/test` install command. It is a floor, not a ceiling, but every agent-scaffolded route starts with a check that fails loudly.

---

## Agent Skills

pracht publishes 33 [Claude Code skills](https://code.claude.com/docs/en/skills). Claude Code loads each from `.claude/skills/<name>/SKILL.md` and runs it with `/<skill-name>`.

| Category                | Skills                                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework & migration   | `/pracht-scaffold`, `/pracht-debug`, `/pracht-deploy`, `/migrate-nextjs`, `/upgrade-pracht`                                                                                                     |
| Audit & review          | `/audit-loaders`, `/audit-shells`, `/audit-islands`, `/audit-auth`, `/audit-csrf`, `/audit-headers`, `/audit-secrets`, `/audit-redirects`, `/audit-deps`, `/audit-bundles`, `/audit-seo`, `/audit-a11y`, `/audit-agent-surface`, `/tune-render-mode`, `/pre-deploy` |
| Testing scaffolds       | `/scaffold-tests`, `/scaffold-e2e`, `/pracht-test-api`                                                                                                                                          |
| App primitives          | `/add-auth`, `/add-db`, `/add-i18n`, `/add-observability`, `/add-content`, `/add-images`, `/add-capabilities`, `/add-openapi`, `/typed-routes`, `/configure-isg`                                 |

Sources and descriptions live in the repo's [skills/ directory](https://github.com/JoviDeCroock/pracht/tree/main/skills) ([README](https://github.com/JoviDeCroock/pracht/blob/main/skills/README.md)). Skills shell out to the same commands [`pracht dev-mcp`](#the-authoring-mcp-server) wraps, such as `pracht inspect … --json`, and read source where a check needs more than the graph. Use either, or both.

### Context Cost

An agent keeps every installed skill's `name` and `description` in context all session; a `SKILL.md` body loads only when run. CI enforces both budgets:

| Budget | Limit | Paid |
| ------ | ----- | ---- |
| One skill's `description` | 500 characters | Every session |
| All 33 descriptions | 12,000 characters (~3k tokens) | Every session |
| One `SKILL.md` | 20,000 bytes | Per invocation |

A typical skill costs about 2k tokens when run. The standing cost is why `create-pracht` seeds only five core skills; each skill is standalone, so install just the ones you use.

### Discovery Endpoint

The skills follow the [agent skills discovery RFC](https://github.com/cloudflare/agent-skills-discovery-rfc). A well-known manifest lists each skill's URL and SHA-256 digest:

```sh
curl https://pracht.resynapse.dev/.well-known/agent-skills/index.json
```

```json
{
  "$schema": "https://agentskills.io/schema/v0.2.0/index.json",
  "skills": [
    {
      "name": "audit-csrf",
      "type": "claude-skill",
      "description": "Verify CSRF posture on forms and mutation APIs...",
      "url": "https://pracht.resynapse.dev/skills/audit-csrf/SKILL.md",
      "sha256": "…"
    }
  ]
}
```

The home page advertises it with an [RFC 8288](https://datatracker.ietf.org/doc/html/rfc8288) `Link` header:

```
Link: </.well-known/agent-skills/index.json>; rel="agent-skills"
```

### Installing One by Hand

In a pracht app, [`pracht skills add`](/docs/cli#pracht-skills) installs a skill and checks its digest. Elsewhere, download it:

```sh
mkdir -p .claude/skills/audit-csrf
curl -o .claude/skills/audit-csrf/SKILL.md \
  https://pracht.resynapse.dev/skills/audit-csrf/SKILL.md
```

Compare its digest with the manifest's `sha256`, then start a new Claude Code session and run `/audit-csrf`:

```sh
shasum -a 256 .claude/skills/audit-csrf/SKILL.md
```

### Seeded by create-pracht

`create-pracht` asks, defaulting to yes:

```
Set up Claude Code skills + MCP? (Y/n):
```

Yes writes the five core skills, an `.mcp.json` for `pracht dev-mcp`, and `AGENTS.md` with a `CLAUDE.md` alias. `--agent-tools=full` seeds the whole catalog and `--no-agent-tools` skips it all; see [create-pracht](/docs/cli#create-pracht).

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

A passing verify means the constraints hold and the snapshot is fresh, and the intent-level diff sits in the PR. Reviewers can focus on whether the change is a good idea.

If the app exposes [capabilities](/docs/capabilities), add [`pracht eval`](/docs/agent-trust#pracht-eval-prove-agent-flows-in-ci): `plan` says the agent surface changed; `eval` says it still works.

### Published docs revision

[`.well-known/pracht-build.json`](/.well-known/pracht-build.json) gives the docs site's source commit and content hashes, so you can tell which framework revision the published guidance, `llms.txt`, and skills come from.
