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

"Agent" means two unrelated things in a pracht app, and the two MCP servers involved are the usual source of confusion. This page is entirely about the first row:

| | Audience | When | What it exposes |
| --- | --- | --- | --- |
| **`pracht dev-mcp`** (this page) | Your coding agent — Claude Code, Cursor, an MCP client on your machine | **Development** | Your app's *graph*: routes, API endpoints, capabilities, diagnostics, scaffolding |
| **[Remote MCP](/docs/capabilities#remote-mcp-tools-for-agents-without-a-browser)** | End-user agents calling your deployed app | **Production** | Your app's *operations*: capabilities served as MCP tools over Streamable HTTP |

`pracht dev-mcp` never ships. It is part of `@pracht/cli`, it runs on your machine, and it is not reachable from your deployed app. Remote MCP is the opposite on every count.

> [!NOTE]
> The command was called `pracht mcp` in earlier releases. That spelling still works as a deprecated alias; new setups should use `pracht dev-mcp`.

Everything below is about making an agent's changes to a pracht app *provable*: LLMs write plausible code, and the interesting review question is rarely "is this valid TypeScript?" — it is "did the intent survive?" Did the new dashboard route keep the auth middleware? Did a route quietly switch from SSR to SSG? Did an API endpoint disappear? Did a capability just become reachable by anyone on the internet?

Those are app-graph questions, and pracht resolves the entire app graph from the manifest, so they are checkable by machine instead of by hoping a reviewer notices.

---

## The Authoring MCP Server

Without it, an agent asked to "add a route" globs `src/`, guesses at the manifest shape, and edits by pattern-match. Every tool on the server is a thin wrapper over the CLI internals and returns the same JSON as `pracht inspect --json`, `pracht doctor --json`, and `pracht verify --json` — so the agent reads the *resolved* graph rather than reconstructing it from source.

```sh
pracht dev-mcp
```

It speaks MCP over stdin/stdout, logs to stderr, and runs until stdin closes. You normally never start it by hand — your MCP client does.

### Registering It

With Claude Code, from an app directory that has `@pracht/cli` installed:

```sh
claude mcp add pracht -- npx --no-install pracht dev-mcp
```

Or check an `.mcp.json` into the repository root so every collaborator and CI agent picks it up automatically:

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

`--no-install` is load-bearing, not a speed optimization: it pins the server to the `@pracht/cli` this project depends on and fails loudly when that binary is missing. Without it, `npx pracht` falls back to fetching an unrelated registry package literally named `pracht`, and an agent ends up describing a CLI the app does not build with.

Apps scaffolded with `create-pracht` get this file — plus the [skills](#agent-skills) in `.claude/skills/` — unless you pass `--no-agent-tools`.

Any client that supports stdio servers works the same way. Cursor (`.cursor/mcp.json`) and VS Code (`.vscode/mcp.json`) take the same `command`/`args` shape; point the working directory at the app root.

### Tools

Every tool accepts an optional `cwd` (absolute path to the app root). When omitted, the server's own working directory is used — which is the app root when the client started it from the project directory.

**Inspection**

| Tool | Inputs | Returns |
| --- | --- | --- |
| `inspect_routes` | `cwd?` | Resolved page routes: path, id, render mode, hydration mode, prefetch strategy, speculation rules, shell, middleware, loader file, plus `notFound` (or `null`). Unset options serialize as `null` |
| `inspect_api` | `cwd?` | Resolved API routes: endpoint path, source file, exported HTTP methods, `hasDefaultHandler` |
| `inspect_capabilities` | `cwd?` | Registered capabilities: name, effect class, exposure transports, HTTP path, middleware, source file, input/output JSON Schemas, plus `mcpEndpoint`, `mcpDestructive`, `mcpRuntimeStatus`, and `mcpUnavailableReasons` |
| `inspect_agents` | `cwd?` | Configured agent surface: Web Bot Auth policy/keys, confirmation mode, remote MCP endpoint, `llms.txt`, per-capability transports and exposure counts |
| `inspect_build` | `cwd?` | Build metadata: adapter target, client entry URL, CSS/JS manifests. Requires a prior `pracht build` |

**Diagnosis and review**

| Tool | Inputs | Returns |
| --- | --- | --- |
| `doctor` | `cwd?` | Wiring diagnostics with per-check status |
| `verify` | `cwd?`, `changed?` | Framework verification with scope info, including `defineApp({ constraints })` enforcement and app-graph snapshot freshness |
| `plan` | `cwd?`, `base?` (git ref, default `origin/main`), `write?` | Semantic app-graph diff against the base ref's committed `.pracht/app-graph.json`: routes, API, capabilities and constraints added, removed, or changed — plus `widensAgentSurface` when a change widened the agent-reachable surface. `write: true` refreshes the snapshot instead |
| `report` | `cwd?`, `base?` | PR-ready markdown assembled from machine truth: the graph diff, verify results, and client JS budgets |
| `get_docs` | — | The embedded pracht authoring guide, the same text as `pracht llms`. Agents should read this before writing pracht code |

**Scaffolding**

| Tool | Inputs |
| --- | --- |
| `generate_route` | `cwd?`, `path`, `render?`, `shell?`, `middleware?`, `loader?`, `errorBoundary?`, `staticPaths?`, `title?`, `revalidate?`, `test?` |
| `generate_shell` | `cwd?`, `name` — manifest apps only |
| `generate_middleware` | `cwd?`, `name` — manifest apps only |
| `generate_api` | `cwd?`, `path`, `methods?` (defaults to `["GET"]`) |
| `generate_capability` | `cwd?`, `name`, `effect?`, `expose?`, `title?`, `description?` — manifest apps only |

Each returns the files created and updated as `{ kind, created, updated }`. `generate_route` emits a Playwright smoke test in `e2e/` when the app has a Playwright setup, which `test` overrides either way. `generate_capability` starts with dependency-free inline JSON Schema. You may replace `input` and `output` with imported Standard JSON Schema validators (including a Zod 4 schema shared with `defineApi()` or `<Form schema>`); keep `expose` and `effect` inline because those still define the browser endpoint table statically.

### Error Handling

Tool failures — a missing manifest, an unknown shell, a refusal to overwrite an existing file — come back as MCP `isError` results carrying the message. The server never crashes on a failed call, so an agent can read the error, correct its input, and retry.

---

## Teaching the Agent: pracht llms

`pracht llms` prints an embedded authoring guide for coding agents — project layout, conventions, constraints, and the verify/plan/report loop. `--write` saves it as `llms.txt` in the app root so agents working in the repo pick it up:

```sh
pracht llms
pracht llms --write
```

The `get_docs` tool serves the same text over MCP, for clients that prefer a tool call to a shell command.

> [!NOTE]
> This is the *framework's* guide, written for an agent editing your source. It is unrelated to the [`llms.txt` your app generates](/docs/agents#llmstxt) from its own graph for agents *using* your deployed site. Same filename, opposite direction.

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

An agent that scaffolds a new route under `/app` without the auth middleware fails verification immediately — no reviewer vigilance required. Manifest apps declare constraints in `defineApp()`; pages apps export them from the root `src/pages/_app.config.ts`. Either way, weakening one is a visible, reviewable policy change rather than a silent drift.

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
! capability notes.purge  now exposed via mcp — reachable by agents
+ constraint require-middleware /app/**  middleware=["auth"]
```

That is the review artifact: added, removed, and changed routes, API endpoints, capabilities, and constraints — not four hundred lines of moved imports. `--json` emits the full report for tooling, and `--markdown` formats the diff for PR comments.

### The Line You Cannot Afford to Miss

A `!` marks a change that widened what agents can reach or weakened one of their guards: a new exposure, a `destructive` capability reclassified out of the confirmation flow, an `agentPolicy` downgraded from `require`, middleware dropped, or an input schema that now accepts more than it used to — a removed `required` field, an opened `additionalProperties`, a raised bound, including nested ones (`input.limit: maximum raised (50 → 5000)`). Narrowings and removals stay quiet.

These are precisely the edits a line diff hides. Moving `mcp: true` into an `expose` object is one word; loosening a schema bound is one number. When anything widened, `--markdown` puts a callout above the diff so a reviewer meets it before the fence, and `pracht report` carries it into the PR body.

Projection switches are part of that graph too. Enabling `agents.mcp` turns declared MCP exposures into remotely served tools; enabling `agents.mcp.destructive` makes the declared destructive subset reachable as well. `pracht plan` records both as `!` widenings, while disabling either stays an ordinary narrowing. The destructive switch is only recorded when at least one declared destructive MCP capability can actually be served, so enabling it in advance does not claim the agent surface widened before a tool exists.

`pracht verify` fails when the committed snapshot no longer matches the live graph, with the fix in the message: run `pracht plan --write`. So route changes cannot land without the snapshot — and therefore the reviewable diff — updating alongside them.

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

Use it as the factual half of a PR description; the author (human or agent) adds the "why". The report footer marks the sections as machine-derived, so reviewers know which claims they do not need to re-check by hand.

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

`--test` forces the test even without a detected Playwright setup; `--no-test` skips it. Generated tests import `@playwright/test`, so install it first with `pnpm add -D @playwright/test` when the app does not already use Playwright; the generator prints this follow-up when needed. The `generate_route` MCP tool accepts a matching `test` boolean.

It is a floor, not a ceiling — but it means every agent-scaffolded route starts life with a failing-loudly check instead of zero coverage.

---

## Agent Skills

pracht publishes 33 [Claude Code skills](https://code.claude.com/docs/en/skills) for scaffolding, auditing, testing, and deploying pracht apps. Each is a single `SKILL.md` — frontmatter (`name`, `version`, `description`, `allowed-tools`) plus an action-oriented body — that Claude Code loads from `.claude/skills/<name>/SKILL.md` and invokes with `/<skill-name>`.

| Category                | Skills                                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework & migration   | `/pracht-scaffold`, `/pracht-debug`, `/pracht-deploy`, `/migrate-nextjs`, `/upgrade-pracht`                                                                                                     |
| Audit & review          | `/audit-loaders`, `/audit-shells`, `/audit-islands`, `/audit-auth`, `/audit-csrf`, `/audit-headers`, `/audit-secrets`, `/audit-redirects`, `/audit-deps`, `/audit-bundles`, `/audit-seo`, `/audit-a11y`, `/audit-agent-surface`, `/tune-render-mode`, `/pre-deploy` |
| Testing scaffolds       | `/scaffold-tests`, `/scaffold-e2e`, `/pracht-test-api`                                                                                                                                          |
| App primitives          | `/add-auth`, `/add-db`, `/add-i18n`, `/add-observability`, `/add-content`, `/add-images`, `/add-capabilities`, `/add-openapi`, `/typed-routes`, `/configure-isg`                                 |

The source of truth lives in the repo's [skills/ directory](https://github.com/JoviDeCroock/pracht/tree/main/skills), with per-skill descriptions in [skills/README.md](https://github.com/JoviDeCroock/pracht/blob/main/skills/README.md). Instead of globbing `src/`, the skills read the resolved app graph via `pracht inspect routes|api|build --json`.

Skills and the MCP server overlap but are not interchangeable. [`pracht dev-mcp`](#the-authoring-mcp-server) exposes graph inspection, `doctor`, `verify`, and the generators as native tools, and nothing else. A skill reaches the same commands by shelling out to `pracht inspect ... --json`, `pracht doctor`, and `pracht verify`, then reads source where the check needs something the graph does not carry — `/audit-islands` opens `src/routes.ts` to see inherited hydration, `/audit-secrets` scans `src/server/**` for values that must not cross to the client. Start from the resolved graph either way; use whichever fits your client, or both.

### Context Cost

Installing the catalog is not free: an agent keeps every skill's `name` and `description` in its system prompt for the whole session, whether or not you invoke anything. The body of a `SKILL.md` is different — it is loaded only when you run `/<skill-name>`.

Both are budgeted, and the budgets are enforced in CI:

| Budget | Limit | Paid |
| ------ | ----- | ---- |
| One skill's `description` | 500 characters | Every session |
| All 33 descriptions | 12,000 characters (~3k tokens) | Every session |
| One `SKILL.md` | 20,000 bytes | Per invocation |

So the whole catalog costs roughly 3k tokens of standing context, and a typical skill costs about 2k more when you actually run it. Descriptions are written as one sentence of what the skill does plus the phrases that should trigger it — the detail lives in the body, where you only pay for it on use.

Installing a subset works fine if you want the bill smaller: each skill is a standalone file with no cross-file dependencies.

### Discovery Endpoint

The skills are published following the [agent skills discovery RFC](https://github.com/cloudflare/agent-skills-discovery-rfc). A well-known manifest lists every skill with a canonical URL and a SHA-256 digest of its source:

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

Agents landing on the home page can find the manifest without prior knowledge — it is advertised with an [RFC 8288](https://datatracker.ietf.org/doc/html/rfc8288) `Link` header:

```
Link: </.well-known/agent-skills/index.json>; rel="agent-skills"
```

Both are emitted by a small Vite plugin ([`vite-plugin-agent-skills.ts`](https://github.com/JoviDeCroock/pracht/blob/main/examples/docs/vite-plugin-agent-skills.ts)) that reads the repo skills at build time, computes the digests, and serves each `SKILL.md` as a public asset.

### Installing One by Hand

Each skill is a plain Markdown file at a stable URL, so installing one into any app is a single `curl` into your `.claude/skills/` directory:

```sh
mkdir -p .claude/skills/audit-csrf
curl -o .claude/skills/audit-csrf/SKILL.md \
  https://pracht.resynapse.dev/skills/audit-csrf/SKILL.md
```

Restart Claude Code (or start a new session) and invoke it with `/audit-csrf`. Verify a download against the manifest's `sha256` if you want integrity checking:

```sh
shasum -a 256 .claude/skills/audit-csrf/SKILL.md
```

### Seeded by create-pracht

New apps do not need to install anything manually. `npm create pracht@latest` asks — with a yes default — whether to set up agent tooling:

```
Set up Claude Code skills + MCP? (Y/n):
```

Accepting seeds two things into the scaffold: the full skill catalog under `.claude/skills/<name>/SKILL.md`, and an `.mcp.json` registering the authoring MCP server so MCP clients pick it up automatically. Pass `--agent-tools` / `--no-agent-tools` to skip the prompt in scripted runs; `--yes` includes the tooling.

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

With that in place the review contract is simple: constraints hold (verify passed), the snapshot is fresh (verify passed), and the intent-level diff is sitting in the PR thread. The human review can spend its attention on whether the change is a good idea — the machine already checked whether it is the change it claims to be.

If the app exposes [capabilities](/docs/capabilities), add [`pracht eval`](/docs/agent-trust#pracht-eval-prove-agent-flows-in-ci) to the same workflow. `plan` tells you the agent surface changed; `eval` tells you it still works.

### Published docs revision

The docs site exposes its source commit and content hashes at
[`.well-known/pracht-build.json`](/.well-known/pracht-build.json).
Use the revision to check which framework checkout the published guidance
comes from. Publication verifies the live pages, `llms.txt`, and skill assets
against the build, so a successful deployment includes the matching agent
reference material.
