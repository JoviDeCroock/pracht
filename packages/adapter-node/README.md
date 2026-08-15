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
- Compresses responses (brotli/gzip via `Accept-Encoding` negotiation) with streaming compression for dynamic bodies and a bounded in-memory LRU/cold-work queue for static assets; disable with `nodeAdapter({ compression: false })` behind a compressing reverse proxy

## Context factory

Generated entries can import an app-level context factory:

```ts
import { nodeAdapter } from "@pracht/adapter-node";

pracht({
  adapter: nodeAdapter({ createContextFrom: "/src/server/context.ts" }),
});
```

`/src/server/context.ts` should export `createContext({ request, req, res })`.
