# create-pracht

Interactive starter CLI for bootstrapping a new pracht app.

## Quickstart

```bash
npm create pracht@latest my-app
cd my-app
npm install
npm run dev
```

## What It Does

- Prompts for the target folder.
- Detects the active package manager from the current environment.
- Lets the user choose between the Node.js, Cloudflare, and Vercel adapters.
- Scaffolds a minimal app with a route manifest or pages router, shell, home route, sample API route, runnable project README, and agent instructions.
- `--dry-run` uses pinned fallback versions and does not require npm registry access.

## Usage

```bash
node ./packages/start/bin/create-pracht.js
node ./packages/start/bin/create-pracht.js my-app --adapter=node --skip-install
node ./packages/start/bin/create-pracht.js my-app --adapter=vercel --skip-install
```

## Generated Files

- `package.json`
- `vite.config.ts`
- `src/routes.ts`
- `src/routes/home.tsx`
- `src/shells/public.tsx`
- `src/api/health.ts`

Cloudflare scaffolds also include:

- `wrangler.jsonc`

## Generated Scripts

- `dev` -> `pracht dev`
- `build` -> `pracht build`

Node starters also include:

- `start` -> `node dist/server/server.js`

Cloudflare starters also include:

- `deploy` -> `pracht build && wrangler deploy`

Vercel starters also include:

- `deploy` -> `pracht build && vercel deploy --prebuilt`
