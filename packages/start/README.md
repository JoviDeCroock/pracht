# create-previte

Interactive starter CLI for bootstrapping a new previte app.

## Quickstart

```bash
npm create previte@latest my-app
cd my-app
npm install
npm run dev
```

## What It Does

- Prompts for the target folder.
- Detects the active package manager from the current environment.
- Lets the user choose between the Node.js, Cloudflare, and Vercel adapters.
- Scaffolds a minimal app with a route manifest, shell, home route, sample API route, and runnable project README.

## Usage

```bash
node ./packages/start/bin/create-previte.js
node ./packages/start/bin/create-previte.js my-app --adapter=node --skip-install
node ./packages/start/bin/create-previte.js my-app --adapter=vercel --skip-install
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

- `dev` -> `previte dev`
- `build` -> `previte build`
- `preview` -> `previte preview`

Cloudflare starters also include:

- `deploy` -> `previte build && wrangler deploy`

Vercel starters also include:

- `deploy` -> `previte build && vercel deploy --prebuilt`

Node starters can be run in production with:

```bash
node dist/server/server.js
```
