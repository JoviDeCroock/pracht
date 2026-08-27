---
title: MCP Server
lead: "`pracht mcp` gives coding agents structured access to your app's resolved graph — inspect routes, API endpoints and capabilities, run diagnostics and verification, and scaffold code — over the Model Context Protocol, on stdio."
breadcrumb: MCP Server
prev:
  href: /docs/agent-skills
  title: Agent Skills
next:
  href: /docs/capabilities
  title: Capabilities
---

## Two Different MCP Servers

Pracht has two, and they serve opposite audiences:

| | Audience | What it exposes |
| --- | --- | --- |
| `pracht mcp` (this page) | Your coding agent, at **development** time | Your app's *graph* — routes, API endpoints, capabilities, diagnostics, scaffolding |
| [Remote MCP](/docs/remote-mcp) | End-user agents, in **production** | Your app's *operations* — capabilities served as MCP tools over Streamable HTTP |

This one never ships. It is part of `@pracht/cli` and runs on your machine.

---

## Why It Exists

Without it, an agent asked to "add a route" globs `src/`, guesses at the
manifest shape, and edits by pattern-match. Every tool here is a thin wrapper
over the CLI internals and returns the same JSON as `pracht inspect --json`,
`pracht doctor --json`, and `pracht verify --json` — so the agent reads the
*resolved* graph rather than reconstructing it from source.

---

## Starting the Server

```sh
pracht mcp
```

It speaks MCP over stdin/stdout, logs to stderr, and runs until stdin closes.
You normally never start it by hand — your MCP client does.

---

## Registering It

With Claude Code, from an app directory that has `@pracht/cli` installed:

```sh
claude mcp add pracht -- npx pracht mcp
```

Or check an `.mcp.json` into the repository root so every collaborator and CI
agent picks it up automatically:

```json [.mcp.json]
{
  "mcpServers": {
    "pracht": {
      "command": "npx",
      "args": ["pracht", "mcp"]
    }
  }
}
```

Apps scaffolded with `create-pracht` get this file — plus the [agent
skills](/docs/agent-skills) in `.claude/skills/` — unless you pass
`--no-agent-tools`.

Any client that supports stdio servers works the same way. Cursor
(`.cursor/mcp.json`) and VS Code (`.vscode/mcp.json`) take the same
`command`/`args` shape; point the working directory at the app root.

---

## Tools

Every tool accepts an optional `cwd` (absolute path to the app root). When
omitted, the server's own working directory is used — which is the app root
when the client started it from the project directory.

### Inspection

| Tool | Inputs | Returns |
| --- | --- | --- |
| `inspect_routes` | `cwd?` | Resolved page routes: path, id, render mode, hydration mode, prefetch strategy, speculation rules, shell, middleware, loader file, plus `notFound` (or `null`). Unset options serialize as `null` |
| `inspect_api` | `cwd?` | Resolved API routes: endpoint path, source file, exported HTTP methods, `hasDefaultHandler` |
| `inspect_capabilities` | `cwd?` | Registered capabilities: name, effect class, exposure transports, HTTP path, middleware, source file, input/output JSON Schemas, plus `mcpEndpoint`, `mcpDestructive`, and `mcpUnavailableReasons` |
| `inspect_agents` | `cwd?` | Configured agent surface: Web Bot Auth policy/keys, confirmation mode, remote MCP endpoint, `llms.txt`, per-capability transports and exposure counts |
| `inspect_build` | `cwd?` | Build metadata: adapter target, client entry URL, CSS/JS manifests. Requires a prior `pracht build` |

### Diagnosis and review

| Tool | Inputs | Returns |
| --- | --- | --- |
| `doctor` | `cwd?` | Wiring diagnostics with per-check status |
| `verify` | `cwd?`, `changed?` | Framework verification with scope info, including `defineApp({ constraints })` enforcement and app-graph snapshot freshness |
| `plan` | `cwd?`, `base?` (git ref, default `origin/main`), `write?` | Semantic app-graph diff against the base ref's committed `.pracht/app-graph.json`: routes, API, capabilities and constraints added, removed, or changed — plus `widensAgentSurface` when a change widened the agent-reachable surface. `write: true` refreshes the snapshot instead |
| `report` | `cwd?`, `base?` | PR-ready markdown assembled from machine truth: the graph diff, verify results, and client JS budgets |
| `get_docs` | — | The embedded pracht authoring guide, the same text as `pracht llms`. Agents should read this before writing pracht code |

See [Agent Workflow](/docs/agent-workflow) for how `plan` and `report` fit into
a review loop.

### Scaffolding

| Tool | Inputs |
| --- | --- |
| `generate_route` | `cwd?`, `path`, `render?`, `shell?`, `middleware?`, `loader?`, `errorBoundary?`, `staticPaths?`, `title?`, `revalidate?`, `test?` |
| `generate_shell` | `cwd?`, `name` — manifest apps only |
| `generate_middleware` | `cwd?`, `name` — manifest apps only |
| `generate_api` | `cwd?`, `path`, `methods?` (defaults to `["GET"]`) |
| `generate_capability` | `cwd?`, `name`, `effect?`, `expose?`, `title?`, `description?` — manifest apps only |

Each returns the files created and updated as `{ kind, created, updated }`.
`generate_route` emits a Playwright smoke test in `e2e/` when the app has a
Playwright setup, which `test` overrides either way.
`generate_capability` keeps `expose`, `effect`, and `input` as inline literals
because the browser projection's static analysis requires it — edit the schemas
and the `run()` body afterwards, not the shape.

---

## Error Handling

Tool failures — a missing manifest, an unknown shell, a refusal to overwrite an
existing file — come back as MCP `isError` results carrying the message. The
server never crashes on a failed call, so an agent can read the error, correct
its input, and retry.

---

## Relationship to Skills

The [agent skills](/docs/agent-skills) shell out to `pracht inspect --json` and
friends. This server exposes the same source of truth as native tools instead,
which suits clients that prefer tool calls over shell access. Both read the
resolved graph; neither reads your source directly.
