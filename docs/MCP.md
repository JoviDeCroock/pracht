# Authoring MCP Server

`pracht dev-mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io) server on
stdio, built into `@pracht/cli`. It gives coding agents (Claude Code, Cursor, and any
other MCP client) native, structured access to the same capabilities the CLI exposes:
inspecting the resolved app graph, diagnosing wiring problems, running framework-aware
verification, and scaffolding routes, shells, middleware, and API handlers.

The graph tools wrap the CLI internals and return the same JSON payloads as the
`--json` flags of `pracht inspect`, `pracht doctor`, and `pracht verify`, so agents
work with the resolved graph instead of globbing `src/`. Runtime diagnostics read
the running local dev server.

> This is the **development-time** server: it exposes your app's *graph* to coding agents.
> To expose your app's *operations* to end-user agents in production, see
> [REMOTE_MCP.md](REMOTE_MCP.md) — the deployed app serves its capabilities as MCP tools
> over Streamable HTTP.

The command was named `pracht mcp` through v1.12. That name still works and behaves
identically, printing a deprecation notice to stderr; it was renamed because it was
constantly read as the app's own remote MCP endpoint.

## Starting the server

```bash
pracht dev-mcp
```

The server speaks the MCP protocol over stdout/stdin; all logging goes to stderr. It runs
until stdin closes. You normally never start it by hand — your MCP client does.

## Registering with Claude Code

From an app directory with `@pracht/cli` installed:

```bash
claude mcp add pracht -- npx pracht dev-mcp
```

Or check a `.mcp.json` into the repository root so every collaborator gets the server
automatically:

```json
{
  "mcpServers": {
    "pracht": {
      "command": "npx",
      "args": ["pracht", "dev-mcp"]
    }
  }
}
```

Apps scaffolded with `create-pracht` get this `.mcp.json` (plus the Claude Code skills in
`.claude/skills/`) out of the box unless scaffolded with `--no-agent-tools`.

## Registering with other MCP clients

Any client that supports stdio servers works the same way — configure the command
`npx pracht dev-mcp` (or `node ./node_modules/@pracht/cli/bin/pracht.js dev-mcp`) with the app
root as the working directory. For example, in Cursor (`.cursor/mcp.json`) or VS Code
(`.vscode/mcp.json`) use the same `command`/`args` shape as the snippet above.

## Tool reference

Every tool accepts an optional `cwd` input (absolute path to the app root). When omitted,
the server's own working directory is used — which is the app root when the client starts
the server from the project directory.

| Tool                  | Inputs                                                                                                              | Returns                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `inspect_routes`      | `cwd?`                                                                                                              | Resolved page routes: path, id, render mode, hydration mode, streaming mode, prefetch strategy, speculation rules, shell, middleware, loader file, plus `notFound` (the app-level 404 page, or `null`). Unset options serialize as `null`. Same as `pracht inspect routes --json`. |
| `inspect_api`         | `cwd?`                                                                                                              | Resolved API routes: endpoint path, source file, exported HTTP methods, `hasDefaultHandler` (default catch-all export). Same as `pracht inspect api --json`. |
| `inspect_capabilities` | `cwd?`                                                                                                          | Registered capabilities: name, effect class, exposure transports, HTTP path, middleware, source file, input/output JSON Schemas, plus `mcpEndpoint`, `mcpDestructive`, `mcpRuntimeStatus`, and `mcpUnavailableReasons`. Same as `pracht inspect capabilities --json`. |
| `inspect_agents`      | `cwd?`                                                                                                              | Configured agent surface: Web Bot Auth policy/keys/directories, destructive-confirmation mode, remote MCP endpoint, whether `llms.txt` is generated, per-capability transports, and exposure counts. Same as `pracht inspect agents --json`. |
| `inspect_build`       | `cwd?`                                                                                                              | Build metadata: adapter target, client entry URL, CSS/JS manifests (requires a prior `pracht build`). Same as `pracht inspect build --json`. |
| `get_runtime_diagnostics` | `url`, `cwd?`, `limit?` (1–50, default 20) | Recent server request errors and capability traffic from this project's running local dev server, including retained failures when its graph no longer loads. |
| `doctor`              | `cwd?`                                                                                                              | Wiring diagnostics with per-check status. Same as `pracht doctor --json`.            |
| `verify`              | `cwd?`, `changed?` (boolean, maps to `--changed`)                                                                   | Framework verification checks with scope info — including `defineApp({ constraints })` enforcement and app-graph snapshot freshness. Same as `pracht verify --json`. |
| `plan`                | `cwd?`, `base?` (git ref, default `origin/main`), `write?` (boolean)                                                | Semantic app-graph diff against the base ref's committed `.pracht/app-graph.json`: routes/API/capabilities/constraints added, removed, changed, plus `widensAgentSurface` when a capability change widened the agent-reachable surface. Same as `pracht plan --json`. `write: true` refreshes the snapshot instead. |
| `report`              | `cwd?`, `base?` (git ref, default `origin/main`)                                                                    | PR-ready markdown assembled from machine truth: app-graph diff, verify results, client JS budgets. Same as `pracht report`. |
| `get_docs`            | `topic?` (page slug, title, or site path; `#section` reads one section)                                             | No topic: the embedded authoring guide (same text as `pracht llms`), unchanged for existing clients. With a topic: that page of the docs bundled into `@pracht/cli` (same as `pracht docs <topic>`). Unknown topics return `isError` with suggestions. |
| `list_docs`           | —                                                                                                                   | The bundled docs index: `version`, `site`, `pages[]` (`slug`, `path`, `url`, `title`, `lead`, `section`). Same as `pracht docs --json`. |
| `search_docs`         | `query`, `limit?` (1–50, default 10)                                                                                | Keyword hits over the bundled pages: `slug`, `title`, `heading`, `anchor`, `snippet`, `score`. Same as `pracht docs --search <query> --json`. |
| `generate_route`      | `cwd?`, `path`, `render?` (`spa`/`ssr`/`ssg`/`isg`), `shell?`, `middleware?` (string[]), `loader?`, `errorBoundary?`, `staticPaths?`, `title?`, `revalidate?` (seconds), `test?` (boolean — emit a Playwright smoke test in `e2e/`; defaults to on when the app has a Playwright setup) | Files created and updated (`{ kind, created, updated }`).                            |
| `generate_shell`      | `cwd?`, `name`                                                                                                      | Files created and updated. Manifest apps only — pages apps add an `_app.tsx` to the directory it should wrap. |
| `generate_middleware` | `cwd?`, `name`                                                                                                      | Files created and updated. Manifest apps accept named middleware; pages apps using a serverful adapter accept `_middleware` for the root middleware applied to every page route. Pure static exports cannot use request middleware. |
| `generate_api`        | `cwd?`, `path`, `methods?` (string[], defaults to `["GET"]`)                                                        | Files created and updated.                                                           |
| `generate_capability` | `cwd?`, `name`, `effect?`, `expose?`, `title?`, `description?`                                                      | Files created and updated. Manifest apps get a `capabilities` registry entry; pages apps auto-discover `src/capabilities/`, so the module declares its own `name`. |

## Implementation

### Live development diagnostics

`get_runtime_diagnostics({ url: "http://localhost:3000/" })` reads the fixed
`/_pracht.json?diagnostics=1` projection (under the URL's base path). It does
not start a server or visit an application route. Request the failing route,
read the diagnostics, fix it, then request the route again. Returned errors
are retained history rather than a claim about the current error state.

The dev middleware serves this projection before evaluating the app graph.
Its `schema` is `pracht-dev-diagnostics/v1`, `root` identifies the Vite project,
and `errors` and `agentTraffic` each contain `{ limit, recorded, events }`.
Errors come from the existing request-error logger, including loader, render,
API, background-task, response-stream, and request-time SSR compilation failures;
expected HTTP outcomes below 500 are omitted. Browser errors, console logs,
and compile failures never observed by a server request are not captured.
The per-server error ring retains 50 newest-first events, each with `at`,
`path`, `phase`, `routeId`, `file`, `message`, and `stack`. Messages are capped
at 4,096 characters and stacks at 8,192. Existing capability traffic retains
200 events. Totals survive eviction; restarting the server clears both rings.

The projection requires a loopback connection and loopback Host, rejects
cross-origin browser requests, removes CORS headers, and sends `no-store`.
It exists only in the standard dev SSR middleware, so adapter-owned dev servers
and production/preview servers do not expose it. The MCP reader accepts only
literal loopback hosts or `localhost` (trying `127.0.0.1` and `::1` without DNS), follows no
redirects, limits the response to 1 MiB and three seconds, and checks that
the returned project root matches `cwd` after resolving symlinks.

### Stdio protocol

The server is tools-only, so `packages/cli/src/mcp-tool-server.ts` implements that slice of
the protocol directly (newline-delimited JSON-RPC over stdio: `initialize`, `ping`,
`tools/list`, `tools/call`) instead of depending on the MCP SDK, which would otherwise ship
its HTTP server stack in every app's `@pracht/cli` install. Tool input schemas are zod raw
shapes converted with `z.toJSONSchema` (draft-7, input side), and invalid arguments or an
unknown tool come back as `isError` results, matching the SDK's behaviour. The tests drive it
with the SDK client (a devDependency) over both in-memory and real stdio transports. Adding
resources, prompts or sampling would mean revisiting this choice.

## Error handling

Tool failures (missing manifest, unknown shell, refusing to overwrite an existing file,
...) are returned as MCP `isError` results carrying the error message. The server never
crashes on a failed tool call, so agents can read the message, correct the input, and
retry.

## Relationship to skills

The repo-local Claude Code skills in [skills/](../skills/README.md) shell out to
`pracht inspect ... --json` and friends. The MCP server exposes the same source of truth
as native tools, which is useful for clients that prefer tool calls over shell access, or
for agents operating on pracht apps outside this repository.
