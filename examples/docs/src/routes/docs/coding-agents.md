---
title: Coding agents
lead: Give coding agents your app graph, these docs over MCP, installable skills, and checks that prove a change does what it claims.
---

Connect a coding agent to the pracht docs first, then to your own app:

| Tool | Gives the agent | Runs |
| --- | --- | --- |
| [Docs MCP server](#the-docs-mcp-server) | Search and read these docs, which track the latest code | Hosted at `https://pracht.resynapse.dev/mcp` |
| [`pracht dev-mcp`](#the-authoring-mcp-server) | Your app's resolved graph: routes, API endpoints, capabilities, diagnostics, scaffolding | Locally, over stdio |
| [Dev page tools](#debugging-in-the-tab-dev-page-tools) | The current browser tab: matched route, loader data, islands, last error, page tools | In every page `pracht dev` serves |
| [Skills](#agent-skills) | Task recipes such as `/add-auth` and `/audit-csrf` | In Claude Code |

None of these ship in your deployed app. For the tools your deployed app serves to *its* users' agents, see [Remote MCP](/docs/mcp-tools#remote-mcp-tools-for-agents-without-a-browser).

The rest of the page covers the checks that make an agent's change reviewable: [constraints](#constraints), the [app-graph snapshot](#the-app-graph-snapshot), [PR reports](#pr-reports-from-machine-truth), and [generated smoke tests](#generated-smoke-tests).

## The docs MCP server

Add the docs server to Claude Code:

```sh
claude mcp add --transport http pracht-docs https://pracht.resynapse.dev/mcp
```

The agent can then search and read these docs instead of relying on its training data. Cursor and VS Code take the URL in their MCP config files:

```json [.cursor/mcp.json]
{
  "mcpServers": {
    "pracht-docs": { "url": "https://pracht.resynapse.dev/mcp" }
  }
}
```

```json [.vscode/mcp.json]
{
  "servers": {
    "pracht-docs": { "type": "http", "url": "https://pracht.resynapse.dev/mcp" }
  }
}
```

The official MCP Registry lists the server as `io.github.JoviDeCroock/pracht-docs`. Its tools are read-only and need no account:

| Tool | Inputs | Returns |
| --- | --- | --- |
| `docs_search` | `query`, `limit?` (1–20, default 8) | The best-matching sections, each with its `page`, `section` anchor, `url`, and a snippet |
| `docs_read` | `page` (a path, slug, or URL), `section?` | One section as Markdown, or the whole page with its section anchors |
| `docs_list` | — | Every page with its one-line summary, grouped like the sidebar |

Pass a search hit's `page` and `section` straight to `docs_read`. An unknown page or anchor answers `found: false` with the closest matches in `suggestions`.

This site is a pracht app, and the server is its own [remote MCP endpoint](/docs/mcp-tools#remote-mcp-tools-for-agents-without-a-browser).

## The authoring MCP server

`pracht dev-mcp` gives an agent the resolved app graph, so it does not have to glob `src/` and guess. Each tool returns the same output as the matching CLI command.

```sh
pracht dev-mcp
```

It speaks MCP over stdio and runs until the client disconnects, so your MCP client starts it. `pracht mcp` is a deprecated alias. See the [CLI reference](/docs/cli#pracht-dev-mcp).

### Registering it

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

Keep `--no-install`. It pins the server to the `@pracht/cli` your project depends on and fails if it is missing; without it, `npx pracht` can fetch an unrelated registry package named `pracht`.

Cursor (`.cursor/mcp.json`), VS Code (`.vscode/mcp.json`), and other stdio clients take the same `command`/`args` shape; run it from the app root. Apps scaffolded with `create-pracht` get this file unless you pass `--no-agent-tools`.

The official MCP Registry lists it as `io.github.JoviDeCroock/pracht`. A registry install runs the latest `@pracht/cli` rather than your project's, so prefer the project config in an app.

### Tools

Every tool accepts an optional `cwd` (absolute path to the app root), defaulting to the server's working directory. A failed call, such as a missing manifest or a refusal to overwrite a file, returns an MCP `isError` result with the message, and the server keeps running so the agent can retry.

**Inspection:** `inspect_routes`, `inspect_api`, `inspect_capabilities`, `inspect_agents`, and `inspect_build` return the same payload as [`pracht inspect <target> --json`](/docs/cli#pracht-inspect). `inspect_build` needs a prior `pracht build`.

**Diagnosis and review:**

| Tool | Inputs | Returns |
| --- | --- | --- |
| `doctor` | — | Wiring diagnostics with per-check status |
| `verify` | `changed?` | Verification results, including [constraints](#constraints) and snapshot freshness |
| `plan` | `base?` (default `origin/main`), `write?` | The [app-graph diff](#the-app-graph-snapshot), with `widensAgentSurface`. `write: true` refreshes the snapshot |
| `report` | `base?` | [PR-ready markdown](#pr-reports-from-machine-truth) |
| `typegen` | `check?` | Regenerates typed routes and capability types; `check: true` only reports staleness |
| `eval` | `url`, `files?` | Runs eval scenarios against an app you already started |
| `get_docs` | `topic?` | Without a topic, the authoring guide from `pracht llms`; agents should read it first. With one, that page (or `page#section`) of the [installed docs](#teaching-the-agent-pracht-llms-and-pracht-docs) |
| `list_docs` | — | The installed docs pages: slug, title, summary, section, URL |
| `search_docs` | `query`, `limit?` | The best-matching docs sections, each with a `slug#section` to pass to `get_docs` |

**Scaffolding:** `generate_route`, `generate_shell`, `generate_middleware`, `generate_api`, and `generate_capability` take the [`pracht generate`](/docs/cli#pracht-generate) flags as camelCase inputs (`errorBoundary`, `staticPaths`), with lists as arrays. Each returns `{ kind, created, updated }`. When you edit a generated capability, keep `expose` and `effect` inline literals.

## Debugging in the tab: dev page tools

Every document `pracht dev` serves registers five read-only [WebMCP](/docs/mcp-tools#webmcp-tools-for-in-browser-agents) page tools, so an agent driving the browser can read the framework's view of the page:

| Tool | Answers |
| --- | --- |
| `pracht_route` | The matched route: id, URL, params, render and hydration mode, streaming, shells, files, middleware, capabilities, and whether it is the not-found page |
| `pracht_loader_data` | The loader data the page holds now, including after client navigation and revalidation. Pass `{ path: "notes.0.title" }` to read one value |
| `pracht_islands` | Every `<pracht-island>` on the page with its source file, client strategy, props, and hydration status |
| `pracht_last_error` | The server error this document rendered (dev overlay or `ErrorBoundary` state), plus recent uncaught client errors with stacks |
| `pracht_page_tools` | The app's own WebMCP tools on this route, and why any declared capability is *not* one |

```sh
pracht dev
# then, from an agent-driven browser on http://localhost:3000/notes:
# pracht_route        → { ok: true, data: { routeId: "notes", render: "ssr", hydration: "full", … } }
# pracht_loader_data  → { ok: true, data: { data: { notes: [ … ] } } }
# pracht_last_error   → { ok: true, data: { server: null, client: [] } }
```

Each tool returns the `{ ok, data }` / `{ ok: false, error }` envelope and carries WebMCP's `debugging: true` annotation. The tools follow client-side navigation, so after a click `pracht_route` describes the new page.

The browser or test harness must support WebMCP; nothing else needs installing. Production builds never contain the tools. Turn them off in dev with `pracht({ devPageTools: false })` in `vite.config.ts`.

- **Islands and no-hydration routes ship no loader data.** On those routes `pracht_loader_data` returns an error naming the request that reads the route state from the server: the route URL with the `x-pracht-route-state-request: 1` header.
- **Keep the dev server private.** Loader data and stack traces contain whatever your loaders return.

## Teaching the agent: pracht llms and pracht docs

Run [`pracht llms`](/docs/cli#pracht-llms) to print pracht's authoring guide for coding agents: project layout, conventions, constraints, and the verify/plan/report loop. `pracht llms --write` saves it as `llms.txt` in the app root, and the `get_docs` MCP tool serves the same text.

Every page of this site also ships inside `@pracht/cli`, matching the release your app installs. [`pracht docs <topic>`](/docs/cli#pracht-docs) prints one, `pracht docs --search <query>` finds sections, and the files are in `node_modules/@pracht/cli/docs/`. The guide and the `AGENTS.md` that `create-pracht` seeds both point there. The site tracks the latest code, so use these when your app is on an older release.

> [!NOTE]
> This is the framework's guide, for an agent editing your source. The [`llms.txt` your app generates](/docs/agents#llmstxt) is for agents using your deployed site.

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
| `requireHead(pattern)`                  | Matching routes export `head()`, directly or via their shell    |

Patterns match route paths segment by segment: `*` matches one segment, a trailing `**` matches zero or more, and `"**"` alone matches every route. `/blog/*` matches `/blog/:slug`.

`pracht verify` reports each violation as an error, so an agent that scaffolds a route under `/app` without `auth` fails verification:

```
✖ Route "/app/billing" is missing required middleware "auth" (constraint pattern "/app/**").
```

Pages-router apps export `constraints` from the root `src/pages/_app.config.ts`. A changed constraint appears in the `pracht plan` diff.

## The app-graph snapshot

Run `pracht plan --write` to snapshot the resolved app graph to `.pracht/app-graph.json`, and commit it like a lockfile:

```sh
pracht plan --write
git add .pracht/app-graph.json
```

`pracht plan` then diffs the live graph against the snapshot committed at a base ref (default `origin/main`). Flags are in the [CLI reference](/docs/cli#pracht-plan).

```
Pracht plan (base: origin/main)

+ route /pricing  render=isg  shell=public  middleware=[]
~ route /app/billing  middleware: [auth] → [auth, audit]
- api   /api/legacy-webhook
! capability notes.purge  now exposed via mcp — reachable by agents
+ constraint require-middleware /app/**  middleware=["auth"]
```

The diff lists only the routes, API endpoints, capabilities, and constraints that changed. `--markdown` formats it for a PR comment.

`pracht verify` fails when the committed snapshot is stale and tells you to run `pracht plan --write`.

### Lines marked `!`

A `!` marks a change that widened what agents can reach or weakened a guard:

- a new exposure
- a `destructive` capability reclassified out of the confirmation flow
- an `agentPolicy` downgraded from `require`
- dropped middleware
- an input schema that accepts more: a removed `required` field, an opened `additionalProperties`, or a raised bound, including nested ones (`input.limit: maximum raised (50 → 5000)`)
- enabling `agents.mcp`, or `agents.mcp.destructive` once a destructive MCP tool can be served

Narrowings and removals are not marked. When anything widened, `--markdown` adds a callout above the diff, and `pracht report` carries it into the PR body.

## PR reports from machine truth

Run [`pracht report`](/docs/cli#pracht-report) to print PR-ready markdown with three sections:

- **App graph changes**: the same diff `pracht plan --markdown` produces.
- **Verification**: the current `pracht verify` result, with any errors and warnings.
- **Client JS budgets**: per-route gzip sizes against their limits, from the last `pracht build`.

Its footer marks these sections as machine-derived; the author adds the reasoning.

## Generated smoke tests

`pracht generate route` writes a Playwright smoke test next to the route when the app has a Playwright setup (a `playwright.config.*` file or an `e2e/` directory):

```sh
pracht generate route --path /blog/:slug --render ssg --shell public
# → src/routes/blog-slug.tsx
# → e2e/blog-slug.spec.ts
```

The test visits the route with example values for dynamic params:

```ts [e2e/blog-slug.spec.ts]
import { expect, test } from "@playwright/test";

test("renders /blog/:slug", async ({ page }) => {
  const response = await page.goto("/blog/example-slug");
  expect(response?.status(), "route should serve successfully").toBeLessThan(400);
  await expect(page.locator("h1").first()).toHaveText("Blog Slug");
});
```

`--test` forces the test and `--no-test` skips it (`test` in the MCP tool). Without Playwright installed, the generator prints the `@playwright/test` install command.

## Agent skills

pracht publishes 33 [Claude Code skills](https://code.claude.com/docs/en/skills). Claude Code loads each from `.claude/skills/<name>/SKILL.md` and runs it with `/<skill-name>`.

| Category                | Skills                                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework & migration   | `/pracht-scaffold`, `/pracht-debug`, `/pracht-deploy`, `/migrate-nextjs`, `/upgrade-pracht`                                                                                                     |
| Audit & review          | `/audit-loaders`, `/audit-shells`, `/audit-islands`, `/audit-auth`, `/audit-csrf`, `/audit-headers`, `/audit-secrets`, `/audit-redirects`, `/audit-deps`, `/audit-bundles`, `/audit-seo`, `/audit-a11y`, `/audit-agent-surface`, `/tune-render-mode`, `/pre-deploy` |
| Testing scaffolds       | `/scaffold-tests`, `/scaffold-e2e`, `/pracht-test-api`                                                                                                                                          |
| App primitives          | `/add-auth`, `/add-db`, `/add-i18n`, `/add-observability`, `/add-content`, `/add-images`, `/add-capabilities`, `/add-openapi`, `/typed-routes`, `/configure-isg`                                 |

Sources and descriptions are in the repo's [skills/ directory](https://github.com/JoviDeCroock/pracht/tree/main/skills). Skills run the same commands [`pracht dev-mcp`](#the-authoring-mcp-server) wraps, such as `pracht inspect … --json`, and read source where a check needs more than the graph. Use either, or both.

### Context cost

An agent keeps every installed skill's `name` and `description` in context all session; a `SKILL.md` body loads only when run. CI enforces these budgets:

| Budget | Limit | Paid |
| ------ | ----- | ---- |
| One skill's `description` | 500 characters | Every session |
| All 33 descriptions | 12,000 characters (~3k tokens) | Every session |
| One `SKILL.md` | 20,000 bytes | Per invocation |

A typical skill costs about 2k tokens when run. Install only the skills you use; each is standalone.

### Discovery endpoint

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

The home page advertises the manifest and the docs index with [RFC 8288](https://datatracker.ietf.org/doc/html/rfc8288) `Link` headers:

```
Link: </llms.txt>; rel="describedby"; type="text/markdown"
Link: </.well-known/agent-skills/index.json>; rel="agent-skills"
```

### Install a skill by hand

In a pracht app, run [`pracht skills add`](/docs/cli#pracht-skills); it installs a skill and checks its digest. Elsewhere, download it:

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

Yes writes four core skills, an `.mcp.json` for `pracht dev-mcp`, and `AGENTS.md` with a `CLAUDE.md` alias. `--agent-tools=full` seeds the whole catalog, and `--no-agent-tools` skips all of it; see [create-pracht](/docs/cli#create-pracht).

## Run the checks in CI

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

A passing `verify` means the constraints hold and the snapshot is fresh. If the app exposes [capabilities](/docs/capabilities), add [`pracht eval`](/docs/agent-eval) to check that agent flows still work.
