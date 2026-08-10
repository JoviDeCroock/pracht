---
"@pracht/core": patch
"@pracht/vite-plugin": patch
"@pracht/cli": patch
"create-pracht": patch
---

A batch of smaller fixes found while dogfooding the framework end to end.

- **Dev server no longer injects the Vite client into non-HTML responses.** A
  missing `content-type` was treated as `text/html`, so `transformIndexHtml`
  ran over bodiless responses — an MCP `notifications/*` 202 came back with
  `<script type="module" src="/@vite/client">` as its body, and so did
  redirects. Production was unaffected.
- **The remote MCP endpoint reports the negotiated protocol version.** Every
  JSON-RPC response stamped `mcp-protocol-version` with the newest version the
  server supports, so a client that initialized at an older version was told
  the connection speaks one it never agreed to.
- **`pracht plan`, `report`, and `verify --changed` no longer leak git's
  stderr.** Outside a git repository — which is what `create-pracht --no-git`
  produces — `fatal: not a git repository` printed above each command's own,
  much better, explanation.
- **`pracht inspect` reports `hydration=full` instead of `hydration=n/a`** for
  routes that use the default, and the `pracht dev` route table gains a
  HYDRATION column when at least one route opts out — `/islands` and `/static`
  were previously indistinguishable from a fully hydrated route in the table
  whose job is to say what runs where.
- **Scaffolded READMEs list the build command**, and bun scaffolds say
  `bun run build`. Every adapter's README covered install/dev/typecheck/
  preview/start but not `build` — and `bun build` is Bun's own bundler, which
  shadows the package script (unlike `bun dev` / `bun start` / `bun preview`,
  which fall through to it). `AGENTS.md` had the same collision.
- **The generated `.mcp.json` invokes `@pracht/cli`.** It ran `npx pracht mcp`,
  which resolves to a registry package literally named `pracht` whenever the
  local bin is not on the path.

Documentation, for behaviour that is working as intended but was undocumented:

- `docs/API_VALIDATION.md` notes that API routes and capabilities use different
  error envelopes (and different `path` encodings), which an agent calling both
  surfaces of one app has to handle.
- `docs/ADAPTERS.md` documents Cloudflare's trailing-slash redirect on
  prerendered nested routes, which makes canonical URLs differ from Node.
- `docs/ROUTING.md` lists what the pages router does not have — middleware,
  named shells, capabilities (and therefore WebMCP, remote MCP, and
  `pracht eval`), constraints, and `agents`.
