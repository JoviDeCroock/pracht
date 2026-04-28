# @pracht/adapter-vercel

Vercel Edge adapter for pracht. Emits Vercel Build Output API v3 output with an Edge Function entry.

## Install

```bash
npm install @pracht/adapter-vercel
```

## Usage

Select the Vercel adapter when scaffolding with `create-pracht`, or add it to an existing project:

```bash
npm create pracht@latest my-app  # choose Vercel
```

Deploy with:

```bash
pracht build && vercel deploy --prebuilt
```

## Features

- Build Output API v3 integration
- Edge Function runtime support
- Static SSG rewrites with route-state bypasses for client navigation

## Context factory

Generated entries can import an app-level context factory:

```ts
import { vercelAdapter } from "@pracht/adapter-vercel";

pracht({
  adapter: vercelAdapter({ createContextFrom: "/src/server/context.ts" }),
});
```

`/src/server/context.ts` should export `createContext({ request, context })`.
