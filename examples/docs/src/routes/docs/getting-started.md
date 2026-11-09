---
title: Quick start
lead: Create a pracht app, run it locally, and ship your first production build.
---

## Requirements

Node 22.18 or newer. Scaffolded apps include an `.nvmrc` and an `engines.node`
field, so hosts and CI pick a supported version.

## Create a project

```sh
pnpm create pracht my-app
```

The CLI asks for:

- an adapter: Node.js, Cloudflare Workers, Netlify, Vercel, or a static export
  (you can switch later in `vite.config.ts`);
- a router: the explicit `src/routes.ts` manifest, or file-system `src/pages/`;
- whether to add Tailwind CSS;
- whether to add agent tooling.

Pick the pages router if file-based routing is enough. You can eject it to a
manifest later when you need per-route shells or middleware, explicit route ids,
path-prefix groups, or webhook ISG; see
[Pages router](/docs/pages-router).

To skip the prompts in CI or scripts, pass the choices as flags:

```sh
pnpm create pracht my-app --adapter=node --router=manifest --template=tailwind --yes
pnpm create pracht my-app --adapter=cf --router=pages --no-tailwind --no-agent-tools --yes
pnpm create pracht my-app --adapter=vercel --skip-install --yes
```

| Flag                         | Effect                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `--adapter=<target>`         | `node` (default), `cf`, `netlify`, `vercel`, or `static`                              |
| `--router=<router>`          | `manifest` (default) or `pages`                                                       |
| `--template=<template>`      | `minimal` or `tailwind`; `--tailwind` and `--no-tailwind` set the same thing          |
| `--agent-tools[=<set>]`      | Add `.claude/skills/`, `.mcp.json`, and `AGENTS.md`; `core` (default) or `full` skills |
| `--no-agent-tools`           | Skip agent files                                                                      |
| `--yes`, `-y`                | Accept defaults and skip all prompts                                                  |
| `--skip-install`, `--no-git` | Skip dependency install, or `git init` and the initial commit                         |
| `--json`                     | Print a JSON summary instead of prose                                                 |
| `--dry-run`                  | List the files that would be created without writing them                             |

## Project structure

A manifest-router scaffold:

```
my-app/
  src/
    routes.ts            # Route manifest (the central wiring file)
    routes/home.tsx      # First page component + loader
    routes/not-found.tsx # Not-found page, wired from the manifest
    shells/public.tsx    # Layout wrapper
    api/health.ts        # Sample API endpoint (not in static exports)
  vite.config.ts         # Vite + pracht plugin config
  package.json
```

A pages-router scaffold uses `src/pages/` instead:

```
my-app/
  src/
    pages/_app.tsx     # App shell
    pages/index.tsx    # First page component + loader
    pages/404.tsx      # Not-found page, wired automatically
    api/health.ts      # Sample API endpoint (not in static exports)
  vite.config.ts       # Vite + pracht plugin config
  package.json
```

Depending on your choices, the starter also includes Tailwind's
`src/styles/global.css`, an adapter file (`wrangler.jsonc`, `netlify.toml`, or
`Dockerfile`), and agent files under `.claude/skills/` plus `.mcp.json`.

### TypeScript settings pracht requires

Set `moduleResolution` to `"bundler"` (or `"node16"` / `"nodenext"`).
pracht's packages are ESM-only and publish their types through `exports`:

```json [tsconfig.json]
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "types": ["vite/client", "@pracht/vite-plugin/virtual"]
  }
}
```

With the legacy `"moduleResolution": "Node"` the app still builds and runs, but
`tsc` fails every `@pracht/core` import with `TS2307`. `create-pracht`
scaffolds the right value, and `pracht doctor` warns about the old one.

See [Import paths](/docs/reference/api#import-paths) for the matching
`tsconfig.client.json`.

## Development

```sh
cd my-app
pnpm dev
```

Open `http://localhost:3000` and edit the first page: `src/routes/home.tsx`
with the manifest router, `src/pages/index.tsx` with the pages router. The
browser updates on save. Set `--port` or `PORT` to use another port.

## Build output

```sh
pnpm build
```

The build writes `dist/client/` (static assets and prerendered SSG pages) and
`dist/server/` (the server bundle in the shape your adapter needs). For a
Node.js target, run the server directly:

```sh
node dist/server/server.js
```

## Deploy

Cloudflare, Netlify, and Vercel scaffolds include the platform config and a
`deploy` script.

### Cloudflare Workers

```sh
pnpm create pracht my-app --adapter=cf --yes
cd my-app
pnpm run deploy
```

The script runs `pracht build && wrangler deploy`. The first run opens a browser
to authorize Wrangler (in CI, set `CLOUDFLARE_API_TOKEN` instead), then prints
your `https://my-app.<your-subdomain>.workers.dev` URL.

> [!NOTE]
> Use `pnpm run deploy`, not `pnpm deploy`: pnpm has a built-in `deploy`
> command that runs instead of the script.

Add KV, D1, R2, or cron triggers in `wrangler.jsonc`; bindings arrive as
`context.env` in loaders and API routes. `pracht preview` serves the built app
locally through Wrangler.

### Vercel

```sh
pnpm create pracht my-app --adapter=vercel --yes
cd my-app
pnpm run deploy
```

The script runs `pracht build && vercel deploy --prebuilt`. The first deploy asks
which Vercel project to link.

### Other targets

Node.js (including Docker), Netlify, and static hosts are each one adapter swap
in `vite.config.ts`. See [Deployment](/docs/deployment) for per-platform
commands and [Adapters](/docs/adapters) for what each adapter emits.

## Next steps

Build [your first shared operation](/docs/recipes/first-workflow): a validated note form, session protection, an agent call, and a production build in the runnable example.

- [Routing](/docs/routing): declare routes, shells, middleware, and render modes in `src/routes.ts`.
- [Rendering modes](/docs/rendering): choose SSR, SSG, ISG, or SPA per route.
- [Data loading](/docs/data-loading): fetch data in loaders and handle mutations in API routes.
- [Adapters](/docs/adapters): deploy to Node.js, Cloudflare Workers, Netlify, Vercel, or a static host.
- [Agents overview](/docs/agents): expose typed operations to agents and to your own UI.
- [Coding agents](/docs/coding-agents#the-docs-mcp-server): connect a coding agent to these docs with `claude mcp add --transport http pracht-docs https://pracht.resynapse.dev/mcp`.
