# Basic Example

This example uses the Node adapter by default. Set `PRACHT_ADAPTER=vercel`
before building to emit Vercel's `.vercel/output/` directory, or
`PRACHT_ADAPTER=cloudflare` to build the Cloudflare Worker output.

Set `PRACHT_ORIGIN` to the app's trusted origin in every environment (for
example, `http://localhost:3000` in local development). The value pins both
request URL construction and relative image source fetches; the image endpoint
fails closed without it.

Cloudflare and Vercel builds omit the Node-only `@pracht/image/node` endpoint
and default to `passthroughLoader`, so the same example deploys without
`sharp` in an edge runtime. A same-origin redirect handler keeps the typed API
graph stable if an old default-loader URL is requested. If the target platform's
image service is enabled, set `PRACHT_IMAGE_BACKEND=cloudflare` or
`PRACHT_IMAGE_BACKEND=vercel` while building to exercise that platform loader
instead.

## Commands

- `pnpm pracht dev` starts the app with the regular Pracht/Vite development server.
- `pnpm pracht build` creates:
  - `dist/client/` for static assets and prerendered HTML
  - `dist/server/server.js` as the server bundle
- `node dist/server/server.js` runs the built Node server locally.
- `pnpm build:cloudflare` creates a Worker bundle and static assets.
- `pnpm deploy:cloudflare` builds and deploys with `wrangler.jsonc`.
- `pnpm typegen` refreshes the committed generated contracts.
- `pnpm typegen:check` proves that those contracts are identical for the Node,
  Cloudflare, and Vercel targets; `pnpm verify` runs that check before validating
  the app graph.

All targets resolve API routes from the same stable module paths. The image endpoint
selects the Sharp-backed Node implementation or its portable edge redirect behind a
compile-time flag, so the deployment changes without rewriting generated API types.

## Agent surface

The example registers five capabilities (`src/capabilities/`) around an
in-memory notes store, demoed by the `/notes` route and advertised in the
generated `/llms.txt`:

- `notes.search` — read, exposed over HTTP, remote MCP, and as a WebMCP page tool
- `notes.create` — write, exposed over HTTP and remote MCP
- `notes.purge` — destructive, HTTP with the prepare/commit confirmation flow
- `agent.whoami` — read, echoes the verified Web Bot Auth identity
- `agent.ping` — read, exposed over HTTP and remote MCP, `agentPolicy: "require"`
  (answers verified agents only, on either transport)

The destructive flow needs a confirmation secret — without it, `notes.purge`
fails closed with `confirmation_unavailable`:

```sh
PRACHT_CONFIRMATION_SECRET=dev-secret pnpm pracht dev
```

Try a capability, then run the scripted agent scenarios in `evals/` — two over
the HTTP projection and two (`*-mcp.eval.json`) over the remote MCP endpoint:

```sh
curl -s -X POST http://localhost:3000/api/capabilities/notes/search \
  -H 'content-type: application/json' -d '{"query":"capabilities"}'

pnpm pracht eval --url http://localhost:3000
```

Or let `pracht eval` manage the server itself:

```sh
PRACHT_CONFIRMATION_SECRET=dev-secret pnpm pracht eval --start "pnpm pracht dev"
```

## Cloudflare deployment

`wrangler.jsonc` deploys the example to `pracht-example.resynapse.dev`. Set the
confirmation secret once so the destructive capability remains fail-closed
and its prepare/commit demo works:

```sh
pnpm wrangler secret put PRACHT_CONFIRMATION_SECRET
pnpm deploy:cloudflare
```

For `PRACHT_ADAPTER=cloudflare pnpm pracht preview`, put the local value in a
gitignored `.dev.vars` file:

```dotenv
PRACHT_CONFIRMATION_SECRET=local-only-secret
```

Wrangler reads Worker bindings from that file; prefixing `pracht preview` with
the host environment variable does not automatically expose it inside the
Worker. This example also has a custom-domain route. Wrangler may print a
localhost preview URL while `request.url` inside the Worker uses
`pracht-example.resynapse.dev`; Web Bot Auth clients must sign that effective
`@authority`. To use a separate config without the custom route, build and run
Wrangler directly because `pracht preview` does not forward `--config`:

```sh
PRACHT_ADAPTER=cloudflare pnpm pracht build
pnpm wrangler dev --config wrangler.local.jsonc --port 3000
```

The local config must keep `main: "dist/server/worker.js"`.

The checked-in deployment uses the passthrough image backend because Cloudflare
Image Resizing is not enabled for this zone. Rebuild with
`PRACHT_IMAGE_BACKEND=cloudflare` after enabling it to use `/cdn-cgi/image`.
