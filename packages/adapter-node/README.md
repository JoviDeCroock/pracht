# @pracht/adapter-node

Node.js HTTP adapter for pracht. Converts Node `http` requests to Web Requests, serves static assets, and handles ISG revalidation.

## Install

```bash
npm install @pracht/adapter-node
```

## Usage

After building with `pracht build`, start the production server:

```bash
node dist/server/server.js
```

## Features

- Converts Node.js HTTP requests to standard Web Requests
- Serves static files from `dist/client/` with streaming, immutable hashed-asset caching, and `ETag` / `Last-Modified` revalidation
- Loads the Vite manifest for asset injection
- Supports ISG time-window revalidation with background regeneration that reuses `createContext()`
- Supports generated-entry context factories via `nodeAdapter({ createContextFrom })`
- Supports configurable request body limits via `nodeAdapter({ maxBodySize })`
- Supports reverse-proxy sub-path rewrites via `nodeAdapter({ basePathStripped: true })`
- Compresses responses (brotli/gzip via `Accept-Encoding` negotiation) with streaming compression for dynamic bodies, a bounded in-memory LRU/cold-work queue for static assets and validator hashing, version-bound file reads, and content-derived ISG validators stable across deployment replicas; disable with `nodeAdapter({ compression: false })` behind a compressing reverse proxy

With a Vite deploy base, the default handler accepts the retained public path:
`/app/assets/main.js` maps to `dist/client/assets/main.js`, while application
code continues to observe `/app/...`. When a trusted reverse proxy removes
that base before forwarding, set `basePathStripped: true`. The explicit setting
avoids confusing a legitimate route whose first segment matches the base with
an unstripped public URL. Pracht restores the configured base before
`createContext()`, loaders, and API handlers receive the request, so
application code still observes the public URL.
In this mode the proxy must also redirect the public bare base (`/app` to
`/app/`), because the stripped origin path could instead be a legitimate
`/app` application route.

## Context factory

Generated entries can import an app-level context factory:

```ts
import { nodeAdapter } from "@pracht/adapter-node";

pracht({
  adapter: nodeAdapter({ createContextFrom: "/src/server/context.ts" }),
});
```

`/src/server/context.ts` should export `createContext({ request, req, res })`.
