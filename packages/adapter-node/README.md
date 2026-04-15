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
- Serves static files from `dist/client/`
- Loads the Vite manifest for asset injection
- Supports ISG time-window revalidation with background regeneration that reuses `createContext()`
