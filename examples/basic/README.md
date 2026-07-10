# Basic Example

This example uses the Node adapter by default. Set `PRACHT_ADAPTER=vercel`
before building to emit Vercel's `.vercel/output/` directory, or
`PRACHT_ADAPTER=cloudflare` to build the Cloudflare Worker output.

## Commands

- `pnpm pracht dev` starts the app with the regular Pracht/Vite development server.
- `pnpm pracht build` creates:
  - `dist/client/` for static assets and prerendered HTML
  - `dist/server/server.js` as the server bundle
- `node dist/server/server.js` runs the built Node server locally.

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
