---
"@pracht/cli": minor
---

Add `pracht mcp`, a stdio Model Context Protocol server built into the CLI. It exposes the existing command internals as native MCP tools for coding agents: `inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify` (with optional `changed` scope), and `generate_route` / `generate_shell` / `generate_middleware` / `generate_api`. Every tool accepts an optional `cwd`, returns the same JSON payloads as the corresponding `--json` CLI flags, and surfaces failures as `isError` results instead of crashing the server. See docs/MCP.md for registration instructions and the tool reference.
