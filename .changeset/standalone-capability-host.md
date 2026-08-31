---
"@pracht/capabilities": minor
"@pracht/core": patch
"@pracht/vite-plugin": patch
---

New `@pracht/capabilities/server` and `@pracht/capabilities/webmcp` entry points publish the capability server core and the WebMCP page-tool registrar: `createCapabilityHost()` mounts capability HTTP endpoints, the remote MCP endpoint, and RFC 9728 metadata inside any server (Express, Hono, Next.js, Workers), and `registerWebmcpTools()` registers page tools on any site. Every `@pracht/core` export is unchanged and re-exported from there, the generated WebMCP shim now registers through the published registrar, and app builds tree-shake the protocol constants out of the client graph (~0.7 KB gzip off a fully hydrated route).
