# previte

Preact-first full-stack framework on Vite with an explicit route manifest, per-route rendering modes, and deploy adapters for Node.js, Cloudflare, and Vercel.

## Quickstart

```bash
pnpm install
pnpm build
pnpm test
pnpm e2e
```

## Create An App

```bash
npm create previte@latest my-app
```

The starter gives you:

- `previte dev` for local SSR + HMR
- `previte build` for client/server output plus SSG/ISG prerendering
- `previte preview` for a production smoke test
- `dist/server/server.js` as the generated Node server entry when targeting Node

## Repo Map

- `VISION_MVP.md` for scope and product direction
- `docs/ARCHITECTURE.md` for framework internals
- `docs/ROUTING.md` for the manifest and matching model
- `docs/RENDERING_MODES.md` for SSR, SSG, ISG, and SPA behavior
- `docs/DATA_LOADING.md` for loaders, actions, forms, and client hooks
- `docs/ADAPTERS.md` for Node, Cloudflare, and Vercel deployment paths
- `packages/start/README.md` for starter CLI details
- `examples/basic` and `examples/cloudflare` for working apps
