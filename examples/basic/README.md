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
