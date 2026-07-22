# MCP Server

`pracht mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io) server on
stdio, built into `@pracht/cli`. It gives coding agents (Claude Code, Cursor, and any
other MCP client) native, structured access to the same capabilities the CLI exposes:
inspecting the resolved app graph, diagnosing wiring problems, running framework-aware
verification, and scaffolding routes, shells, middleware, and API handlers.

Every tool is a thin wrapper over the CLI internals and returns the same JSON payloads as
the `--json` flags of `pracht inspect`, `pracht doctor`, and `pracht verify`, so agents
work with the resolved graph instead of globbing `src/`.

## Starting the server

```bash
pracht mcp
```

The server speaks the MCP protocol over stdout/stdin; all logging goes to stderr. It runs
until stdin closes. You normally never start it by hand — your MCP client does.

## Registering with Claude Code

From an app directory with `@pracht/cli` installed:

```bash
claude mcp add pracht -- npx pracht mcp
```

Or check a `.mcp.json` into the repository root so every collaborator gets the server
automatically:

```json
{
  "mcpServers": {
    "pracht": {
      "command": "npx",
      "args": ["pracht", "mcp"]
    }
  }
}
```

## Registering with other MCP clients

Any client that supports stdio servers works the same way — configure the command
`npx pracht mcp` (or `node ./node_modules/@pracht/cli/bin/pracht.js mcp`) with the app
root as the working directory. For example, in Cursor (`.cursor/mcp.json`) or VS Code
(`.vscode/mcp.json`) use the same `command`/`args` shape as the snippet above.

## Tool reference

Every tool accepts an optional `cwd` input (absolute path to the app root). When omitted,
the server's own working directory is used — which is the app root when the client starts
the server from the project directory.

| Tool                  | Inputs                                                                                                              | Returns                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `inspect_routes`      | `cwd?`                                                                                                              | Resolved page routes: path, id, render mode, shell, middleware, loader file. Same as `pracht inspect routes --json`. |
| `inspect_api`         | `cwd?`                                                                                                              | Resolved API routes: endpoint path, source file, exported HTTP methods. Same as `pracht inspect api --json`. |
| `inspect_build`       | `cwd?`                                                                                                              | Build metadata: adapter target, client entry URL, CSS/JS manifests (requires a prior `pracht build`). Same as `pracht inspect build --json`. |
| `doctor`              | `cwd?`                                                                                                              | Wiring diagnostics with per-check status. Same as `pracht doctor --json`.            |
| `verify`              | `cwd?`, `changed?` (boolean, maps to `--changed`)                                                                   | Framework verification checks with scope info — including `defineApp({ constraints })` enforcement and app-graph snapshot freshness. Same as `pracht verify --json`. |
| `plan`                | `cwd?`, `base?` (git ref, default `origin/main`), `write?` (boolean)                                                | Semantic app-graph diff against the base ref's committed `.pracht/app-graph.json`: routes/API/constraints added, removed, changed. Same as `pracht plan --json`. `write: true` refreshes the snapshot instead. |
| `report`              | `cwd?`, `base?` (git ref, default `origin/main`)                                                                    | PR-ready markdown assembled from machine truth: app-graph diff, verify results, client JS budgets. Same as `pracht report`. |
| `get_docs`            | —                                                                                                                   | The embedded pracht authoring guide for coding agents (same text as `pracht llms`). Read it before authoring pracht app code. |
| `generate_route`      | `cwd?`, `path`, `render?` (`spa`/`ssr`/`ssg`/`isg`), `shell?`, `middleware?` (string[]), `loader?`, `errorBoundary?`, `staticPaths?`, `title?`, `revalidate?` (seconds), `test?` (boolean — emit a Playwright smoke test in `e2e/`; defaults to on when the app has a Playwright setup) | Files created and updated (`{ kind, created, updated }`).                            |
| `generate_shell`      | `cwd?`, `name`                                                                                                      | Files created and updated. Manifest apps only.                                       |
| `generate_middleware` | `cwd?`, `name`                                                                                                      | Files created and updated. Manifest apps only.                                       |
| `generate_api`        | `cwd?`, `path`, `methods?` (string[], defaults to `["GET"]`)                                                        | Files created and updated.                                                           |

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
