# pracht

Preact-first full-stack framework on Vite with an explicit route manifest, per-route rendering modes, and deploy adapters for Node.js, Cloudflare, and Vercel.

## Quickstart

```bash
pnpm install
pnpm build
pnpm format:check
pnpm test
pnpm e2e
```

`pnpm install` now runs the repo `prepare` hook, which installs the Playwright
Chromium browser used by the E2E suite.

For CI-parity checks, run `pnpm typecheck`, `pnpm format:check`, `pnpm lint`, `pnpm test`, and `pnpm e2e`.

## Contributing

Use the GitHub issue templates for bug reports and feature requests. When opening a pull request, follow [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md).

## Create An App

```bash
npm create pracht@latest my-app
```

The starter gives you:

- `pracht dev` for local SSR + HMR
- `pracht build` for client/server output plus SSG/ISG prerendering
- `pracht inspect [routes|api|build] --json` for resolved app graph metadata
- `pracht generate route|shell|middleware|api` for framework-native scaffolding
- `pracht verify` for fast framework-aware checks with `--changed` and `--json`
- `pracht doctor` for app wiring checks with optional JSON output
- `dist/server/server.js` as the generated Node server entry when targeting Node

## Repo Map

- `VISION_MVP.md` for scope and product direction
- `docs/ARCHITECTURE.md` for framework internals
- `docs/ROUTING.md` for the manifest and matching model
- `docs/RENDERING_MODES.md` for SSR, SSG, ISG, and SPA behavior
- `docs/DATA_LOADING.md` for loaders, actions, forms, and client hooks
- `docs/STYLING.md` for the recommended styling approaches (CSS Modules, Tailwind) and current CSS-in-JS limitations
- `docs/ADAPTERS.md` for Node, Cloudflare, and Vercel deployment paths
- `packages/start/README.md` for starter CLI details
- `examples/basic` and `examples/cloudflare` for working apps
