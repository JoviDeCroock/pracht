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

## Agent surface

The example registers five capabilities (`src/capabilities/`) around an
in-memory notes store, demoed by the `/notes` route and advertised in the
generated `/llms.txt`:

- `notes.search` — read, exposed over HTTP and as a WebMCP page tool
- `notes.create` — write, HTTP
- `notes.purge` — destructive, HTTP with the prepare/commit confirmation flow
- `agent.whoami` — read, echoes the verified Web Bot Auth identity
- `agent.ping` — read, `agentPolicy: "require"` (answers verified agents only)

The destructive flow needs a confirmation secret — without it, `notes.purge`
fails closed with `confirmation_unavailable`:

```sh
PRACHT_CONFIRMATION_SECRET=dev-secret pnpm pracht dev
```

Try a capability, then run the scripted agent scenario in `evals/`:

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

The checked-in deployment uses the passthrough image backend because Cloudflare
Image Resizing is not enabled for this zone. Rebuild with
`PRACHT_IMAGE_BACKEND=cloudflare` after enabling it to use `/cdn-cgi/image`.
