---
"@pracht/capabilities": minor
---

New `@pracht/capabilities/server` entry point hosts the full capability server core — dispatch pipeline, agent trust layer, and remote MCP projection — and adds `createCapabilityHost()`, which mounts capability HTTP endpoints, the MCP endpoint, and RFC 9728 metadata inside any server (Express, Hono, Next.js, Workers) from capabilities registered at runtime. New `@pracht/capabilities/webmcp` entry point publishes `registerWebmcpTools()`, the WebMCP page-tool registration runtime, for pracht and non-pracht sites alike.
