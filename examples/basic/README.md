# Basic Example

This example uses the Node adapter by default. Set `PREVITE_ADAPTER=vercel`
before building to emit Vercel's `.vercel/output/` directory instead.

## Commands

- `pnpm previte dev` starts the app with the regular Previte/Vite development server.
- `pnpm previte build` creates:
  - `dist/client/` for static assets and prerendered HTML
  - `dist/server/server.js` as the server bundle
- `pnpm previte preview` previews the production build locally.
